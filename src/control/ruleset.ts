/** Future metadata contract only. Nothing here is downloaded or executed in this MVP. */
export interface DeclarativeRuleset {
    schemaVersion: 1;
    version: string;
    rules: {
        id: string;
        title: string;
        profiles: ('TERMINAL' | 'SERVER')[];
        fact: string;
        operator: 'exists' | 'equals' | 'minimum';
        expected?: string | number | boolean;
        description: string;
    }[];
}
