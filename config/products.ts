export const productBuilds = {
    client: { entry: '/src/apps/client/main.tsx', outDir: 'dist/client', port: 1420 },
    support: { entry: '/src/apps/support/main.tsx', outDir: 'dist/support', port: 1421 },
    web: { entry: '/src/apps/web/main.tsx', outDir: 'dist/web', port: 1422 }
} as const;

export function getProductBuild(mode: string) {
    if (mode === 'client' || mode === 'support' || mode === 'web') return productBuilds[mode];
    if (mode === 'development' || mode === 'production') return productBuilds.web;
    throw new Error(`Modo de produto desconhecido: ${mode}`);
}
