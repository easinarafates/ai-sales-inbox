// Verifier: Inbox banner removal + notifications bell wiring (2026-11-08).
// Checks source + the LIVE API (real cancel-request notification for ASI-0006).
import fs from 'node:fs';
import jwt from '../apps/api/node_modules/jsonwebtoken/index.js';
const WEB = '/home/hatch/workspace/ai-sales-inbox/apps/web';
const API = 'https://ai-sales-inbox-api.vercel.app';
let pass = 0, fail = 0;
function check(name, ok, detail = '') { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; }
const shell = fs.readFileSync(`${WEB}/components/AppShell.tsx`, 'utf8');
const inbox = fs.readFileSync(`${WEB}/app/inbox/page.tsx`, 'utf8');
// (a) Banner gone
check('banner: "Customer Inbox" title removed from inbox page', !inbox.includes('Customer Inbox') && !inbox.includes('inbox.bannerTitle'));
check('banner: subtitle removed from inbox page', !inbox.includes('inbox.bannerSubtitle') && !inbox.includes('All your customer chats'));
check('banner: stat cards + search still present', inbox.includes('StatCard') && inbox.includes('Search chats') && inbox.includes('Conversations'));
// (b) Bell wired to /api/notifications
check('bell: polls /api/notifications?limit=20', shell.includes('"/api/notifications?limit=20"'));
check('bell: mark-read posts /api/notifications/:id/read', shell.includes('`/api/notifications/${n.id}/read`'));
check('bell: no bare /notifications call remains', !/api\.get\("$\/notifications/.test(shell) && !shell.includes('"/notifications?') && !shell.includes('`/notifications/'));
check('bell: unread badge renders when unreadCount>0', shell.includes('unreadCount > 0'));
check('bell: click opens the notification conversation', shell.includes('/inbox?conversation=${n.conversation_id}'));
// (c) Live API returns the real ASI-0006 cancel-request notification
const apiEnv = fs.readFileSync('/home/hatch/workspace/ai-sales-inbox/apps/api/.env', 'utf8');
const secret = apiEnv.match(/^JWT_SECRET=(.+)$/m)[1].trim();
const token = jwt.sign({ userId: 'b0d895c5-836c-46c4-9822-b6b8049dacc0', workspaceId: '2683f2fd-b8d4-4480-b8b7-ac126ca37a28', isOwner: false }, secret, { expiresIn: '5m' });
const res = await fetch(`${API}/api/notifications?limit=20`, { headers: { Authorization: `Bearer ${token}` } });
const j = await res.json();
check('live API: GET /api/notifications returns 200', res.status === 200);
check('live API: unreadCount >= 1', (j.unreadCount ?? 0) >= 1, `unreadCount=${j.unreadCount}`);
const asi6 = (j.notifications ?? []).find(n => n.order_id === 'a3ecf2e8-711f-4725-a096-1f1bc15f9150');
check('live API: ASI-0006 cancel-request notification present + unread', !!asi6 && asi6.is_read === false && asi6.type === 'cancel_request', asi6 ? asi6.body : 'missing');
check('live API: ASI-0006 notification links to the "কে আমি" conversation', !!asi6 && asi6.conversation_id === 'e62792ec-4361-4258-bff7-150049450287');
// (d) Root-cause regression: the exact URL the bell used to call must 404 (proves it was wrong)
const bad = await fetch(`${API}/notifications?limit=20`, { headers: { Authorization: `Bearer ${token}` } });
check('root cause: GET /notifications (no /api prefix) is 404', bad.status === 404, `HTTP ${bad.status}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
