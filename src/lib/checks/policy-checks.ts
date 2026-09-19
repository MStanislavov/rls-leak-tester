/** RLS003, RLS004 and RLS005: what the policy expressions say, read as text and never evaluated. */
import type { Catalog, CatalogPolicy } from "@/lib/runner/introspect";
import { compareCheckToUsing, isLiterallyTrue, readsUserMetadata } from "./expression";
import { evidence, finding, policyObject } from "./finding";
import { bypassesRls } from "./roles";
import type { Finding, FindingEvidence, StaticCheckContext } from "./types";

function policyEvidence(policy: CatalogPolicy): FindingEvidence[] {
  return [
    evidence("command", policy.command.toUpperCase()),
    evidence("roles", policy.roles.join(", ")),
    evidence("using", policy.using ?? "(none)"),
    evidence("with check", policy.withCheck ?? "(none)"),
  ];
}

/** RLS003: a permissive policy that is literally `true` for a role that is subject to RLS. */
export function checkPolicyAlwaysTrue(catalog: Catalog): Finding[] {
  const findings: Finding[] = [];
  for (const policy of catalog.policies) {
    const clauses = [
      ...(isLiterallyTrue(policy.using) ? ["USING"] : []),
      ...(isLiterallyTrue(policy.withCheck) ? ["WITH CHECK"] : []),
    ];
    const affected = policy.roles.filter((role) => !bypassesRls(catalog, role));
    if (!policy.permissive || clauses.length === 0 || affected.length === 0) {
      continue;
    }
    const command = policy.command === "all" ? "every command" : policy.command.toUpperCase();
    findings.push(
      finding("RLS003", policyObject(policy), {
        explanation: `${clauses.join(" and ")} of this permissive policy is the constant true, so it admits every row for ${command}, for ${
          affected.includes("PUBLIC") ? "every role (PUBLIC)" : affected.join(", ")
        }. Permissive policies are combined with OR: a stricter policy on the same table does not narrow this one. If every row really is meant to be reachable, keep it and set the expectation to "all"; otherwise replace true with the condition that ties a row to its user or tenant.`,
        evidence: [evidence("literally true", clauses.join(", ")), ...policyEvidence(policy)],
      }),
    );
  }
  return findings;
}

/** RLS004: an UPDATE or ALL policy whose explicit WITH CHECK is provably looser than USING. */
export function checkLooseWithCheck(catalog: Catalog): Finding[] {
  const findings: Finding[] = [];
  for (const policy of catalog.policies) {
    if (policy.command !== "update" && policy.command !== "all") {
      continue;
    }
    const result = compareCheckToUsing(policy.using, policy.withCheck);
    // A restrictive policy without USING and with WITH CHECK (true) restricts nothing and, being
    // AND-ed, loosens nothing either.
    if (!result.looser || (!policy.permissive && result.reason === "check-true-without-using")) {
      continue;
    }
    const how = {
      "check-true":
        "WITH CHECK is the constant true while USING is a real condition: the policy limits which rows can be updated, but not what they are turned into.",
      "check-true-without-using":
        "WITH CHECK is the constant true and there is no USING. By itself the policy reaches no row, but permissive policies are combined with OR, so it switches the new-row check off for every other UPDATE policy that applies to the same roles.",
      "drops-conditions":
        "WITH CHECK repeats only a part of the conditions that USING combines with AND, so the new row no longer has to meet the dropped ones.",
      "adds-alternatives":
        "WITH CHECK accepts what USING accepts OR further alternatives, so a new row may satisfy an alternative that USING would never show.",
    }[result.reason];
    findings.push(
      finding("RLS004", policyObject(policy), {
        explanation: `${how}${
          policy.permissive
            ? ""
            : " The policy is restrictive: its USING narrows which rows can be updated, but the new row is not held to the same restriction."
        } A user can therefore update a row they reach into one they could not reach, for example into another tenant or to another owner. Leaving WITH CHECK out is safe, Postgres then applies USING to the new row; an explicit one should be at least as strict.`,
        evidence: [
          ...policyEvidence(policy),
          ...(result.dropped.length > 0
            ? [evidence("conditions of using not in with check", result.dropped.join("; "))]
            : []),
          ...(result.added.length > 0
            ? [evidence("alternatives only in with check", result.added.join("; "))]
            : []),
        ],
      }),
    );
  }
  return findings;
}

/** RLS005, `supabase` mode only: a policy expression that reads user-editable metadata. */
export function checkUserMetadata(catalog: Catalog, context: StaticCheckContext): Finding[] {
  if (context.mode !== "supabase") {
    return [];
  }
  const findings: Finding[] = [];
  for (const policy of catalog.policies) {
    const clauses = [
      ...(readsUserMetadata(policy.using) ? ["USING"] : []),
      ...(readsUserMetadata(policy.withCheck) ? ["WITH CHECK"] : []),
    ];
    if (clauses.length === 0) {
      continue;
    }
    findings.push(
      finding("RLS005", policyObject(policy), {
        explanation: `${clauses.join(" and ")} of this policy reads user_metadata. On Supabase that part of the token (raw_user_meta_data in auth.users) can be changed by the signed-in user through the auth API, so whoever wants the role or tenant this policy looks for can give it to themselves. Authorization data belongs in app_metadata (raw_app_meta_data), which only the server side can write.`,
        evidence: [
          evidence("reads user_metadata in", clauses.join(", ")),
          ...policyEvidence(policy),
        ],
      }),
    );
  }
  return findings;
}
