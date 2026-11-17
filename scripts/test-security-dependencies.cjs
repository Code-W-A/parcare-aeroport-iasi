// Offline compatibility smoke checks for the updated legacy dependencies.
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const nodemailer = require('nodemailer');
async function main() {
  const rows = [{ days: 1, standardPrice: 30 }, { days: 2, standardPrice: 60 }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), 'Tarife');
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  const restored = XLSX.read(bytes, { type: 'buffer' });
  assert.deepEqual(XLSX.utils.sheet_to_json(restored.Sheets.Tarife), rows);
  // streamTransport only generates bytes locally; no network/email delivery.
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const mail = await transport.sendMail({
    from: 'qa@example.com', to: 'local@example.com',
    subject: 'Test local Iași', text: 'Verificare compatibilitate',
  });
  assert.ok(Buffer.isBuffer(mail.message));
  assert.ok(mail.message.toString().includes('Verificare compatibilitate'));
  console.log('SheetJS round trip and local email generation passed; no messages delivered.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
