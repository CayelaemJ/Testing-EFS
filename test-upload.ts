import { readFileSync } from 'fs';
import { uploadAndValidate } from './src/services/importService.js';

const buffer = readFileSync('./test_debt_accounts.csv');
uploadAndValidate({
  reportKey: 'debt_accounts',
  filename: 'test_debt_accounts.csv',
  buffer,
  uploadedBy: 'test'
}).then(result => {
  console.log('Result:', JSON.stringify(result, null, 2));
}).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

