import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../ComputerDiagnosticPage.tsx', import.meta.url), 'utf8');
const adminService = await readFile(new URL('../../services/windows/WindowsAdminService.ts', import.meta.url), 'utf8');

test('Computer Diagnostic keeps a compact network overview and delegates complete details', () => {
  assert.match(page, /getNetworkSummary\(snapshot\.network\.items\)/);
  assert.match(page, /Gateway IPv4/);
  assert.match(page, /DNS:/);
  assert.match(page, /Abrir detalhes no Diagnóstico de Rede/);
  assert.doesNotMatch(page, /IPv6|MAC:/);
});

test('Computer Diagnostic includes printer status, share metadata and expandable technical evidence', () => {
  assert.match(page, /getPrinterHealth/);
  assert.match(page, /Nome compartilhado/);
  assert.match(page, /Caminho\/share/);
  assert.match(page, /Ver detalhes técnicos/);
  assert.match(page, /source/);
});

test('Windows admin actions map to fixed Tauri commands and contain no arbitrary command input', () => {
  assert.match(adminService, /computerManagement: 'open_computer_management'/);
  assert.match(adminService, /adminTerminal: 'open_admin_terminal'/);
  assert.match(adminService, /change_hostname/);
  assert.doesNotMatch(adminService, /Command::new|powershell\.exe|cmd\.exe/);
});
