/**
 * Unit checks for inferGenderFromName (customers/gender.ts).
 * Run by scripts/verify-gender-addressing.mjs via `npx tsx` in apps/api.
 * Prints one JSON object per case to stdout: {"name","expected","got","ok"}.
 */
import { inferGenderFromName } from '../apps/api/src/customers/gender';

const CASES: [string, 'male' | 'female' | 'unknown'][] = [
  ['Mohammad Easin', 'male'],
  ['মোহাম্মদ ইমন', 'male'],
  ['মোঃ রফিক', 'male'],
  ['Md. Kamal', 'male'],
  ['Rahim Uddin', 'male'],
  ['নুরুল ইসলাম', 'male'],
  ['Sakib Al Hasan', 'male'],
  ['আব্দুল করিম', 'male'],
  ['Fatima Begum', 'female'],
  ['ফাতেমা বেগম', 'female'],
  ['নুসরাত জাহান', 'female'],
  ['Nusrat Jahan', 'female'],
  ['Jannat', 'female'],
  ['আয়েশা সিদ্দিকা', 'female'],
  ['Priya', 'female'],
  ['মিসেস রেহানা', 'female'],
  ['নূর', 'unknown'],
  ['Noor', 'unknown'],
  ['Alex', 'unknown'],
  ['', 'unknown'],
  ['Rahim Fatema', 'unknown'],
  ['Unknown', 'unknown'],
];

for (const [name, expected] of CASES) {
  const got = inferGenderFromName(name);
  console.log(JSON.stringify({ name, expected, got, ok: got === expected }));
}
