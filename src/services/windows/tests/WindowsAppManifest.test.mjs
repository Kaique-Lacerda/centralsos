import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../../../src-tauri/windows-app-manifest.xml',import.meta.url),'utf8');
const build=readFileSync(new URL('../../../../src-tauri/build.rs',import.meta.url),'utf8');
test('manifesto Windows exige administrador com uiAccess false e preserva Common Controls',()=>{assert.match(source,/<requestedExecutionLevel\s+level="requireAdministrator"\s+uiAccess="false"\s*\/>/);assert.match(source,/<trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">/);assert.match(source,/name="Microsoft.Windows.Common-Controls"/);for(const attr of ['version="6.0.0.0"','processorArchitecture="*"','publicKeyToken="6595b64144ccf1df"','language="*"'])assert.ok(source.includes(attr));assert.equal((source.match(/<requestedExecutionLevel\b/g)??[]).length,1);});
test('build usa WindowsAttributes do Tauri para embutir o manifesto em Windows',()=>{assert.match(build,/#\[cfg\(windows\)\]/);assert.match(build,/\.app_manifest\(include_str!\("windows-app-manifest.xml"\)\)/);assert.match(build,/tauri_build::try_build\(attributes\)/);assert.doesNotMatch(build,/new_without_app_manifest|runas|Command::new/);});
