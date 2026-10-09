// The only way into src/realtime/ from outside; only tests of a single module import it directly.
export { attachGateway, type Gateway } from './connection/gateway.ts';
export { forkWorkpiece, mergeWorkpiece } from './forks/forks.ts';
export { createWorkpieceHub, type Connection, type WorkpieceHub } from './hub/hub.ts';
export { deleterOf, readStateAt } from './hub/persistence.ts';
