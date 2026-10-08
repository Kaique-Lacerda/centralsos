/** Only Client has an official installer source today; never reuse its asset for Support. */
export const distributionProducts = {
    client: { name: 'CENTRAL SOS Cliente', state: 'published-source', description: 'Aplicativo do PC atendido: diagnóstico e ferramentas locais.' },
    support: { name: 'CENTRAL SOS Suporte', state: 'in-development', description: 'Futuro aplicativo operacional do técnico.' }
} as const;
