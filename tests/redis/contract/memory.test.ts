/** The contract suite on the in-memory adapters. Hermetic: it runs on every `npm test`. */
import { describeRedisContract } from "./contract";
import { createMemoryHarness } from "./harness";

describeRedisContract("in-memory adapters", createMemoryHarness);
