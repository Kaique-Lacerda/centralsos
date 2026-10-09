import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const components = [
  { name: 'central-sos.exe', destination: 'central-sos.exe', level: 'requireAdministrator' },
  { name: 'central-sos-agent.exe', destination: 'Agent/central-sos-agent.exe', level: 'asInvoker' },
  { name: 'central-sos-session-helper.exe', destination: 'Agent/central-sos-session-helper.exe', level: 'asInvoker' },
];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// Tauri restores the original bundle marker on the loose executable after bundling.
// Compare a COPY using the exact NSIS marker. No other byte can differ; never modify
// the executable, its permissions or its signature here.
export function clientImageForNsis(bytes) {
  const unknown = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
  const nsis = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS');
  const a = bytes.indexOf(unknown), b = bytes.indexOf(nsis);
  if ((a < 0) === (b < 0) || (a >= 0 && bytes.indexOf(unknown, a + 1) >= 0)
    || (b >= 0 && bytes.indexOf(nsis, b + 1) >= 0)) throw Error('INSTALLER_MAIN_BINARY_MISMATCH');
  const normalized = Buffer.from(bytes);
  if (a >= 0) nsis.copy(normalized, a);
  return normalized;
}

// Parse actual PE resource directories; a string found elsewhere in a binary is not a manifest.
export function inspectExecutable(bytes, level) {
  const fail = () => { throw Error('INSTALLER_IMAGE_INVALID'); };
  const slice = (offset, length) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > bytes.length) fail();
    return bytes.subarray(offset, offset + length);
  };
  const u16 = offset => slice(offset, 2).readUInt16LE();
  const u32 = offset => slice(offset, 4).readUInt32LE();
  if (slice(0, 2).toString() !== 'MZ') fail();
  const pe = u32(0x3c);
  if (!slice(pe, 4).equals(Buffer.from([80, 69, 0, 0])) || u16(pe + 4) !== 0x8664) fail();
  const sections = u16(pe + 6), optional = pe + 24, optionalSize = u16(pe + 20);
  if (!sections || sections > 96 || optionalSize < 240 || u16(optional) !== 0x20b || u16(optional + 68) !== 2) fail();
  const sectionTable = optional + optionalSize;
  const rvaOffset = rva => {
    for (let index = 0; index < sections; index++) {
      const s = sectionTable + index * 40;
      const start = u32(s + 12), rawSize = u32(s + 16), raw = u32(s + 20);
      if (rva >= start && rva - start < rawSize) return raw + rva - start;
    }
    fail();
  };
  const resourcesRva = u32(optional + 112 + 2 * 8);
  if (!resourcesRva) fail();
  const resourceBase = rvaOffset(resourcesRva);
  const entries = offset => {
    const count = u16(resourceBase + offset + 12) + u16(resourceBase + offset + 14);
    if (count > 1024) fail();
    return Array.from({ length: count }, (_, index) => {
      const entry = resourceBase + offset + 16 + index * 8;
      return { id: u32(entry), target: u32(entry + 4) };
    });
  };
  const manifestType = entries(0).filter(entry => entry.id === 24);
  if (manifestType.length !== 1 || !(manifestType[0].target & 0x80000000)) fail();
  const manifestIds = entries(manifestType[0].target & 0x7fffffff);
  const mainManifest = manifestIds.filter(entry => entry.id === 1);
  if (mainManifest.length !== 1 || !(mainManifest[0].target & 0x80000000)) fail();
  const languages = entries(mainManifest[0].target & 0x7fffffff);
  if (languages.length !== 1 || languages[0].target & 0x80000000) fail();
  const data = resourceBase + languages[0].target;
  const manifest = slice(rvaOffset(u32(data)), u32(data + 4));
  if (manifest.length > 65536) fail();
  const text = manifest[0] === 0xff && manifest[1] === 0xfe ? manifest.subarray(2).toString('utf16le') : manifest.toString('utf8');
  const levels = [...text.matchAll(/<requestedExecutionLevel\b[^>]*\blevel=["']([^"']+)["'][^>]*>/g)];
  if (levels.length !== 1 || levels[0][1] !== level || !/\buiAccess=["']false["']/.test(levels[0][0])) fail();
  return { architecture: 'x64', manifestLevel: level, size: bytes.length, sha256: sha256(bytes) };
}
export async function readExecutable(path, level) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 512 * 1024 * 1024) throw Error('INSTALLER_IMAGE_INVALID');
  const bytes = await readFile(path);
  return { bytes, ...inspectExecutable(bytes, level) };
}
export function validateEmbeddedPackage(installer, images, manifest) {
  // NSIS compression is deliberately disabled: verify byte-for-byte payload presence without
  // executing the installer or relying on an external archive extractor. The generated script
  // is validated separately against the pinned hook and source files.
  if (installer.length < 4096 || installer.subarray(0, 2).toString() !== 'MZ'
    || !installer.includes(Buffer.from('NullsoftInst'))) throw Error('INSTALLER_NSIS_INVALID');
  if (manifest.files?.length !== components.length || new Set(manifest.files.map(file => file.sha256)).size !== components.length) throw Error('INSTALLER_PAYLOAD_MISSING_OR_CHANGED');
  for (const component of components) {
    const image = images[component.name];
    inspectExecutable(image, component.level);
    const assets = manifest.files.filter(file => file.name === component.name);
    const asset = assets[0];
    if (assets.length !== 1 || asset.sha256 !== sha256(image) || asset.size !== image.length || !installer.includes(image)) throw Error('INSTALLER_PAYLOAD_MISSING_OR_CHANGED');
  }
  return { components: components.map(component => component.name), verified: true };
}
