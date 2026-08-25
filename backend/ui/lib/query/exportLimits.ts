// The ceiling on one export, shared by the client and the server.
//
// Held apart from lib/query/export so a component can state the limit it is
// asking within without pulling the warehouse driver and the platform store
// into the browser bundle.
//
// Not a memory limit: nothing holds the file whole any more. It is a statement
// about what an export is for, which is a spreadsheet somebody works with. Past
// this the honest answer is a table in the warehouse, not a download.
export const maxExportRows = 50000;
