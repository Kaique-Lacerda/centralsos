export function volumeKind(type: number | null | undefined): string {
  return ({ 2: 'Removível', 3: 'Fixo', 4: 'Rede', 5: 'CD-ROM', 6: 'RAM' } as Record<number, string>)[type ?? 0] ?? 'Não determinado';
}
