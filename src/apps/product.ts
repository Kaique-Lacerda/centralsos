export type Product = 'client' | 'support' | 'web';
export type HostRuntime = 'web' | 'desktop';

/** Product ownership is distinct from the host; Support is currently a browser preview. */
export function getProductRuntime(product: Product, host: HostRuntime) {
    return {
        product,
        host,
        identity: product === 'web' ? 'public-web' : `${product}-${host === 'desktop' ? 'desktop' : 'web-preview'}`,
        localMachineAccess: product === 'client' && host === 'desktop'
    };
}
