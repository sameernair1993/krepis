import type { Collection } from 'mongodb';

// A data layer in its own module, as in real apps: every query leaves from one line here, so the nearest frame alone
// never names the loop that calls it. Both wrapper styles occur in the wild and differ on V8's async stack.

/** Awaits: stays on the async stack, so the chain is `this file ← the loop`. */
export const getAwaiting = async (coll: Collection, id: unknown) => await coll.findOne({ _id: id as never });

/** Returns the promise: drops off the async stack, so the chain starts at the loop. */
export const getReturning = async (coll: Collection, id: unknown) => coll.findOne({ _id: id as never });

// Helpers calling helpers inside one module (NodeBB: sorted.js:86 ← sorted.js:108 ← sorted.js:18). Three frames here
// would use up a three-frame chain before the loop if hops were counted per frame rather than per file.
const fetchOne = async (coll: Collection, id: unknown) => await coll.findOne({ _id: id as never });
const fetchMany = async (coll: Collection, id: unknown) => await fetchOne(coll, id);
export const getNested = async (coll: Collection, id: unknown) => await fetchMany(coll, id);
