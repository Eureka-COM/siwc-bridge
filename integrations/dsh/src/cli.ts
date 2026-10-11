#!/usr/bin/env node
import { createServices, signIn, saveModel, statusText, PRIVACY_NOTICE } from './admin.js';
import { safeFailure } from './errors.js';

const [command = 'help', value] = process.argv.slice(2);
const { auth, adapter, diagnostics } = createServices();
const cancellation = new AbortController();
process.once('SIGINT', () => { cancellation.abort(); adapter.cancelRequests(); auth.abortAll(); });
try {
  if (command === 'login' || command === 'enable-plan') {
    console.log(PRIVACY_NOTICE);
    console.log(await signIn(auth, { registrationId: value, forceConsent: command === 'enable-plan', signal: cancellation.signal }));
  } else if (command === 'status') console.log(await statusText(auth, adapter, diagnostics));
  else if (command === 'models') console.log((await adapter.listModelsFresh('siwc', cancellation.signal)).map(m => `${m.id}\t${m.name}`).join('\n'));
  else if (command === 'model' && value) { await saveModel(auth, value); console.log(`次回の起動時の既定モデル: ${value}`); }
  else if (command === 'select' && value) { await auth.select(value); console.log('登録を切り替えました。\n' + await statusText(auth, adapter, diagnostics)); }
  else if (command === 'sign-out') { const row = await auth.signOut(cancellation.signal); console.log(row.remoteRevocation === 'confirmed' ? 'サインアウトしました（失効確認済み）。' : 'この端末のトークンを削除しました（サーバー側の失効は未確認）。'); }
  else if (command === 'diagnostics') console.log([diagnostics.location, ...await diagnostics.tail(50)].join('\n'));
  else console.log('dsh-siwc: login [登録ID] | status | models | model <slug> | select <登録ID> | sign-out | diagnostics\n使い始め: login → npm.cmd start（モデルはDSH画面で選べます）');
} catch (error) { console.error(safeFailure(error)); process.exitCode = 1; }
finally { adapter.cancelRequests(); auth.abortAll(); }
