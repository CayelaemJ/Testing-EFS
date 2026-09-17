import { readFileSync } from 'fs';
import { uploadAndValidate, commitBatch } from './dist/services/importService.js';

async function test() {
  try {
    console.log('=== STEP 1: Upload employers ===');
    const empl = await uploadAndValidate({
      reportKey: 'employers',
      filename: 'test_employers.csv',
      buffer: readFileSync('./test_employers.csv'),
      uploadedBy: 'test'
    });
    console.log('Employers validation result:');
    console.log('  OK:', empl.result.ok);
    console.log('  Row count:', empl.result.rowCount);
    console.log('  Errors:', empl.result.errors.length);
    console.log('  Batch ID:', empl.batch?.id);
    
    if (empl.batch) {
      console.log('Committing employers...');
      const empStats = await commitBatch(empl.batch.id);
      console.log('Employers committed:', empStats);
    }

    console.log('\n=== STEP 2: Upload employees ===');
    const emps = await uploadAndValidate({
      reportKey: 'employees',
      filename: 'test_employees.csv',
      buffer: readFileSync('./test_employees.csv'),
      uploadedBy: 'test'
    });
    console.log('Employees validation result:');
    console.log('  OK:', emps.result.ok);
    console.log('  Row count:', emps.result.rowCount);
    console.log('  Errors:', emps.result.errors.length);
    if (emps.result.errors.length > 0) {
      emps.result.errors.slice(0, 3).forEach(e => {
        console.log(`    Row ${e.row}, ${e.column}: ${e.reason}`);
      });
    }
    console.log('  Batch ID:', emps.batch?.id);

    if (emps.batch) {
      console.log('Committing employees...');
      const empStats = await commitBatch(emps.batch.id);
      console.log('Employees committed:', empStats);
    }

    console.log('\n=== STEP 3: Upload platform_users ===');
    const pus = await uploadAndValidate({
      reportKey: 'platform_users',
      filename: 'test_platform_users.csv',
      buffer: readFileSync('./test_platform_users.csv'),
      uploadedBy: 'test'
    });
    console.log('Platform users validation result:');
    console.log('  OK:', pus.result.ok);
    console.log('  Row count:', pus.result.rowCount);
    console.log('  Errors:', pus.result.errors.length);
    if (pus.result.errors.length > 0) {
      pus.result.errors.slice(0, 3).forEach(e => {
        console.log(`    Row ${e.row}, ${e.column}: ${e.reason}`);
      });
    }
    console.log('  Batch ID:', pus.batch?.id);

    if (pus.batch) {
      console.log('Committing platform_users...');
      const pusStats = await commitBatch(pus.batch.id);
      console.log('Platform users committed:', pusStats);
    }

    console.log('\n=== STEP 4: Upload debt_accounts ===');
    const deb = await uploadAndValidate({
      reportKey: 'debt_accounts',
      filename: 'test_debt_accounts.csv',
      buffer: readFileSync('./test_debt_accounts.csv'),
      uploadedBy: 'test'
    });
    console.log('Debt accounts validation result:');
    console.log('  OK:', deb.result.ok);
    console.log('  Row count:', deb.result.rowCount);
    console.log('  Errors:', deb.result.errors.length);
    if (deb.result.errors.length > 0) {
      deb.result.errors.slice(0, 5).forEach(e => {
        console.log(`    Row ${e.row}, ${e.column}: ${e.reason}`);
      });
    }
    console.log('  Batch ID:', deb.batch?.id);

    if (deb.batch) {
      console.log('Committing debt_accounts...');
      const debStats = await commitBatch(deb.batch.id);
      console.log('Debt accounts committed:', debStats);
    }

  } catch (err) {
    console.error('ERROR:', err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  }
}

test();

