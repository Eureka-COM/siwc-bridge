#!/usr/bin/env node
import { createServices, PRIVACY_NOTICE, MANAGE_USAGE, CREDIT_NOTICE, startMessage, saveModel, statusText } from './admin.js';
import { startPersonalUse, finishVerification, verificationStatus, resumeInference } from './ledger.js';
import { safeFailure } from './errors.js';
import { createInterface } from 'node:readline/promises';

const [command = 'help', value] = process.argv.slice(2);
const { auth, adapter } = createServices();
const cancellation = new AbortController();
process.once('SIGINT', () => { cancellation.abort(); adapter.cancelRequests(); auth.abortAll(); });
try {
  if (command === 'login' || command === 'enable-plan') {
    console.log(PRIVACY_NOTICE);
    console.log('Continue with ChatGPT: 公式ブラウザで本人ログインと利用許可を行ってください。推論は開始しません。');
    await auth.login({ registrationId: value, forceConsent: command === 'enable-plan', signal: cancellation.signal });
    console.log(await statusText(auth, adapter));
    console.log('次は初回確認: node lib/cli.js confirm（ここで利用を開始します）。その後 models → model <slug>。');
  } else if (command === 'status') console.log(await statusText(auth, adapter));
  else if (command === 'confirm') {
    await auth.confirmPlan();
    console.log(`You're using your ChatGPT plan. Got it.\nUsing ChatGPT plan / Manage usage: ${MANAGE_USAGE}`);
    console.log(startMessage(await startPersonalUse()));
    console.log(CREDIT_NOTICE);
  }
  else if (command === 'models') console.log((await adapter.listModelsFresh('siwc', cancellation.signal)).map(m => `${m.id}\t${m.name}`).join('\n'));
  else if (command === 'model' && value) { await saveModel(auth, adapter, value); console.log(`モデルを選択しました: ${value}`); }
  else if (command === 'select' && value) { await auth.select(value); console.log('登録を切り替えました。新しい会話を開始してください。\n' + await statusText(auth, adapter)); }
  else if (command === 'sign-out') { adapter.cancelRequests(); const row = await auth.signOut(cancellation.signal); console.log(row.remoteRevocation === 'confirmed' ? '失効応答確認済み・ローカルトークン削除済み。登録とhost IDは保持。' : 'ローカルトークン削除済み。リモート失効未確認。ChatGPT設定からDisconnectしてください。'); }
  else if (command === 'verification-status') console.log(JSON.stringify(await verificationStatus()));
  else if (command === 'finish-verification') { await finishVerification(); console.log('本人操作でライブ検証の6要求予算を終了しました。通常の個人利用へ進む前に利用設定を確認してください。'); }
  else if (command === 'begin') {
    // v0.2.0 compatibility: the start now happens at confirm; no typed START is needed.
    console.log(startMessage(await startPersonalUse()));
    console.log(CREDIT_NOTICE);
  }
  else if (command === 'resume') {
    if (!process.stdin.isTTY) throw new Error('本人の対話ターミナルで再開してください。');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await prompt.question(`本人が ${MANAGE_USAGE} でクレジット不使用設定を保存・確認し、停止前の利用を再開する場合は START と入力してください（検証要求累計はリセットしません）: `, { signal: cancellation.signal });
      if (answer !== 'START') console.log('再開していません。');
      else { await resumeInference({ settingsConfirmed: true }); adapter.resetUsageLimit(); console.log('本人操作で停止前の利用を再開しました。検証予算と累計は保持しています。'); }
    } finally { prompt.close(); }
  }
  else console.log('dsh-siwc: login [registration] | enable-plan <registration> | status | confirm | models | model <slug> | select <registration> | sign-out | verification-status | finish-verification | resume\n使い始め: login → confirm → models → model <slug> → npm.cmd start\n動作確認だけ行う場合: npm.cmd run live-test -- --begin');
} catch (error) { console.error(safeFailure(error)); process.exitCode = 1; }
finally { adapter.cancelRequests(); auth.abortAll(); }
