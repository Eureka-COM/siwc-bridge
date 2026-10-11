import type { Context } from '@deepseek-ai/cordis';
import { CredentialProvider, credentialKey } from '@deepseek-ai/dsh-credentials';
import type {
  CredentialInfo, CredentialKey, CredentialRecord, CredentialRecordEntry,
  CredentialRecordInfo, CredentialRef, ResolvedCredential,
} from '@deepseek-ai/dsh-credentials';

const WEB_KEY = credentialKey('client-connection', 'browser-session');

/** Web Connection only: its Node-crypto signing key expires with this process. No file or OAuth store. */
export default class MemoryWebCredentials extends CredentialProvider {
  private record: CredentialRecord | undefined;
  private operations: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(ctx: Context) {
    super(ctx);
    ctx.effect(() => () => { this.closed = true; this.record = undefined; });
  }

  override resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> { return Promise.resolve(undefined); }
  override describe(_ref: CredentialRef): Promise<CredentialInfo> { return Promise.resolve({ configured: false, writable: false }); }
  override set(_ref: CredentialRef, _value: string): Promise<void> { return Promise.reject(new Error('このWeb資格情報サービスはAPIキーを保存しません。')); }
  override unset(_ref: CredentialRef): Promise<void> { return Promise.reject(new Error('このWeb資格情報サービスはAPIキーを保存しません。')); }

  override readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(key === WEB_KEY ? this.copy() : undefined);
  }
  override describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    return Promise.resolve(key === WEB_KEY && this.record !== undefined
      ? { configured: true, kind: this.record.kind, writable: true }
      : { configured: false, writable: key === WEB_KEY });
  }
  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve(this.record === undefined ? [] : [{ key: WEB_KEY, kind: this.record.kind }]);
  }

  override modifyRecord(key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined> {
    return this.enqueue(async () => {
      this.assertWebKey(key);
      const next = await mutate(this.copy());
      this.assertWebKey(key);
      if (next !== undefined) {
        if (next.kind !== 'grant') throw new Error('Web接続以外の資格情報を保存できません。');
        this.record = structuredClone(next);
        this.notifyRecordUpdated(key);
      }
      return this.copy();
    });
  }
  override deleteRecord(key: CredentialKey): Promise<void> {
    return this.enqueue(async () => {
      this.assertWebKey(key);
      if (this.record !== undefined) { this.record = undefined; this.notifyRecordUpdated(key); }
    });
  }

  private copy(): CredentialRecord | undefined { return this.record === undefined ? undefined : structuredClone(this.record); }
  private assertWebKey(key: CredentialKey): void {
    if (this.closed || key !== WEB_KEY) throw new Error('この資格情報サービスは有効なWeb接続だけに使用できます。');
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation);
    this.operations = task.then(() => undefined, () => undefined);
    return task;
  }
}
