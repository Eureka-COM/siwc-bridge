#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { createWindowsClient, MANAGE_USAGE, PRIVACY_NOTICE, safeFailure } from './index.js';

const args = process.argv.slice(2);
const value = (flag: string): string | undefined => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const help = 'SIWC Bridge (Windows Node.js 24+)\nUsage: siwc-bridge --app-id <id> --app-name <name> <command>\nCommands: login [registration-id] | confirm | status | models | begin --max-requests <1..1000> | stop | select <registration-id> | sign-out\nログインだけでは推論を開始しません。beginは本人の設定確認とSTART入力が必要です。';

async function main(): Promise<void> {
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(help); return; }
  const appId = value('--app-id'); const appName = value('--app-name');
  if (!appId || !appName || appId.startsWith('--') || appName.startsWith('--')) throw new Error(help);
  const remaining = args.filter((_arg, index) => ![args.indexOf('--app-id'), args.indexOf('--app-id') + 1, args.indexOf('--app-name'), args.indexOf('--app-name') + 1].includes(index));
  const [command, argument] = remaining;
  const runtime = createWindowsClient({ appId, appName });
  try {
    if (command === 'login') {
      console.log(PRIVACY_NOTICE);
      console.log(`Continue with ChatGPT: ${appName}`);
      console.log(JSON.stringify(await runtime.auth.login({ registrationId: argument }), null, 2));
    } else if (command === 'confirm') {
      await runtime.auth.confirmPlan();
      console.log(`You're using your ChatGPT plan. Got it.\nManage usage: ${MANAGE_USAGE}`);
    } else if (command === 'status') {
      console.log(JSON.stringify({ auth: await runtime.auth.status(), budget: await runtime.budget.status(), manageUsage: MANAGE_USAGE }, null, 2));
    } else if (command === 'models') console.log(JSON.stringify(await runtime.client.listModels(), null, 2));
    else if (command === 'select' && argument) await runtime.auth.select(argument);
    else if (command === 'stop') { await runtime.stop(); console.log('新しい推論を停止しました。'); }
    else if (command === 'sign-out') { runtime.client.clearReplayHistory(); console.log(JSON.stringify(await runtime.auth.signOut(), null, 2)); }
    else if (command === 'begin') {
      const maxRequests = Number(value('--max-requests') ?? 6);
      if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 1000) throw new Error('要求数は1〜1000の整数で指定してください。');
      if (!process.stdin.isTTY) throw new Error('beginは本人の対話ターミナルで実行してください。');
      console.log(`本人が ${MANAGE_USAGE} でアプリ週間上限100%未満、またはアプリのクレジット利用OFFを保存・確認してください。`);
      console.log('自動購入OFFだけでは既存クレジット消費を防げません。プログラムからこの設定は確認・変更できません。');
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await prompt.question(`次の最大${maxRequests}推論要求をこのアプリに許可する本人操作の場合は START と入力してください: `);
        if (answer !== 'START') { console.log('開始していません。'); return; }
      } finally { prompt.close(); }
      console.log(JSON.stringify(await runtime.begin({ maxRequests, creditSettingsConfirmed: true }), null, 2));
    } else throw new Error(help);
  } finally { runtime.client.cancelRequests(); runtime.auth.abortAll(); }
}
try { await main(); }
catch (error) {
  console.error(error instanceof Error && !(error.name === 'BridgeError') ? '入力または処理を確認してください。\n' + help : safeFailure(error));
  process.exitCode = 1;
}
