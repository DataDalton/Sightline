"use client";

// One implementation, shared with the server.
//
// The server seeds answers under the same key the client asks with, so the two
// must agree exactly. Re-exported rather than reimplemented, because a second
// copy is a second thing to keep in step and the failure when they drift is
// silent: the seed lands under a key nobody reads.
export { canonicalRequest as canonical } from "../../lib/query/requestKey";
