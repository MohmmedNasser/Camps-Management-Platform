/**
 * Accounts offered as one-click logins on the login screen — real Supabase
 * accounts (password `123456` for all), not mock/localStorage data. Kept as
 * its own small file since core/store.js's mock dataset it used to live
 * beside is gone (data/mock-data.js deleted — the backend is real now).
 */

import { ROLES } from '../core/config.js';

export const demoAccounts = [
  { email: 'admin@camps.ps', role: ROLES.CAMP_ADMIN, label: 'مسؤول مخيم', hint: 'مخيم النور' },
  { email: 'super@camps.ps', role: ROLES.SUPER_ADMIN, label: 'مدير النظام', hint: 'كل المخيمات' },
  { email: 'ahmad@camps.ps', role: ROLES.DISPLACED, label: 'نازح', hint: 'أحمد محمود الشريف' },
];
