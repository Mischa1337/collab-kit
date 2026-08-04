// N1 (Erweiterung) — WS-Schreib-Gating: die reine Entscheidungslogik isWriteMessage.
// y-protocol: Byte0 = Nachrichtentyp (0=sync,1=awareness); Byte1 = sync-Subtyp (0=step1,1=step2,2=update).
import { isWriteMessage } from '../services/websocket/readonly';

describe('isWriteMessage', () => {
  it('sync/SyncStep2 (1) ist schreibend → true', () => {
    expect(isWriteMessage(new Uint8Array([0, 1]))).toBe(true);
  });
  it('sync/Update (2) ist schreibend → true', () => {
    expect(isWriteMessage(new Uint8Array([0, 2]))).toBe(true);
  });
  it('sync/SyncStep1 (0) ist eine Leseanfrage → false', () => {
    expect(isWriteMessage(new Uint8Array([0, 0]))).toBe(false);
  });
  it('Awareness (Typ 1) ist erlaubt → false', () => {
    expect(isWriteMessage(new Uint8Array([1, 0, 5]))).toBe(false);
  });
  it('leere/zu kurze Nachricht → false', () => {
    expect(isWriteMessage(new Uint8Array([]))).toBe(false);
    expect(isWriteMessage(new Uint8Array([0]))).toBe(false);
  });
  it('akzeptiert auch Buffer/ArrayBuffer', () => {
    expect(isWriteMessage(Buffer.from([0, 2]))).toBe(true);
    expect(isWriteMessage(new Uint8Array([0, 2]).buffer)).toBe(true);
  });
});
