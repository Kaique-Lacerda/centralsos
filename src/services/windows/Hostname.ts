export interface HostnameValidation {
  valid: boolean;
  message: string;
}

export function validateHostname(value: string): HostnameValidation {
  const hostname = value.trim();
  if (!hostname) return { valid: false, message: 'Informe um hostname.' };
  if (hostname.length > 15) return { valid: false, message: 'O hostname deve ter no máximo 15 caracteres.' };
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(hostname)) {
    return { valid: false, message: 'Use somente letras, números ou hífens; não comece nem termine com hífen.' };
  }
  return { valid: true, message: '' };
}
