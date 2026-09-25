import type { InstalledSoftware, ValidationResult, ValidationRule } from '../../types';

function make(id: string, title: string, category: ValidationResult['category'], status: ValidationResult['status'], description: string, expected?: string, actual?: string): ValidationResult {
  return { ruleId: id, title, category, status, severity: status === 'error' ? 'error' : status === 'warning' ? 'warning' : 'info', description, expected, actual };
}

function softwareInstalled(id: string, title: string, category: ValidationResult['category'], apps: InstalledSoftware[] | undefined, error: string | null | undefined): ValidationResult {
  if (!apps) return make(id, title, category, 'ignored', error || 'A consulta de programas instalados não está disponível.', `${title} instalado`, 'Não verificável');
  if (apps.length === 0) return error ? make(id, title, category, 'ignored', error, `${title} instalado`, 'Não verificável') : make(id, title, category, 'error', `${title} não foi encontrado nas entradas consultadas do Registro do Windows.`, `${title} instalado`, 'Não encontrado');
  const actual = apps.map(app => `${app.name}; versão ${app.version || 'não informada'}; localização ${app.location || 'não informada'}`).join(' · ');
  return make(id, title, category, 'success', error ? `Instalação encontrada; consulta parcial: ${error}` : 'Instalação encontrada. Versão e localização são exibidas quando informadas pelo Windows.', `${title} instalado`, actual);
}

function softwareVersion(id: string, title: string, category: ValidationResult['category'], apps: InstalledSoftware[] | undefined, error: string | null | undefined, expectedVersion: string): ValidationResult {
  if (!apps) return make(id, title, category, 'ignored', error || 'A consulta de versão não está disponível.', expectedVersion, 'Não verificável');
  const versions = apps.map(app => app.version).filter((version): version is string => Boolean(version));
  if (versions.length === 0) return make(id, title, category, 'ignored', error || 'O Windows não informou uma versão do produto.', expectedVersion, 'Versão não informada');
  const found = versions.find(version => version.trim() === expectedVersion);
  return make(id, title, category, found ? 'success' : 'warning', found ? 'Versão esperada encontrada.' : 'A versão instalada diverge da versão esperada.', expectedVersion, [...new Set(versions)].join(', '));
}

const rules: ValidationRule[] = [
  {
    id: 'server-database-file', name: 'Banco autocom.fdb', category: 'database', profiles: ['server'],
    validate: ({ installation }) => {
      const check = installation?.databaseExists;
      if (!check || check.value === null) return make('server-database-file', 'Banco autocom.fdb', 'database', 'ignored', check?.error || 'Consulta não disponível.', String.raw`C:\SoS Soluções\Troia\Banco\autocom.fdb`, 'Não verificável');
      const exists = check.value === 'true';
      return make('server-database-file', 'Banco autocom.fdb', 'database', exists ? 'success' : 'error', exists ? 'Arquivo do banco encontrado.' : 'Arquivo do banco não encontrado.', String.raw`C:\SoS Soluções\Troia\Banco\autocom.fdb`, exists ? 'Encontrado' : 'Ausente');
    }
  },
  {
    id: 'server-firebird-installed', name: 'Firebird instalado', category: 'firebird', profiles: ['server'],
    validate: ({ installation }) => {
      if (!installation || installation.firebirdError) return make('server-firebird-installed', 'Firebird instalado', 'firebird', 'ignored', installation?.firebirdError || 'Consulta não disponível.', 'Serviço Firebird encontrado', 'Não verificável');
      const services = installation.firebirdServices;
      return services.length ? make('server-firebird-installed', 'Firebird instalado', 'firebird', 'success', 'Serviço Firebird encontrado.', 'Firebird instalado', services.map(s => `${s.displayName || s.serviceName} · ${s.path || 'caminho não informado'}`).join('; ')) : make('server-firebird-installed', 'Firebird instalado', 'firebird', 'error', 'Nenhum serviço Firebird foi encontrado.', 'Firebird instalado', 'Não encontrado');
    }
  },
  {
    id: 'server-firebird-version', name: 'Versão do Firebird', category: 'firebird', profiles: ['server'],
    validate: ({ installation }) => {
      if (!installation || installation.firebirdError) return make('server-firebird-version', 'Versão do Firebird', 'firebird', 'ignored', installation?.firebirdError || 'Consulta não disponível.', '2.5.9.27139', 'Não verificável');
      const versions = [...new Set(installation.firebirdServices.map(s => s.version).filter((v): v is string => Boolean(v)))];
      if (!versions.length) return make('server-firebird-version', 'Versão do Firebird', 'firebird', 'ignored', 'A versão não pôde ser lida dos arquivos dos serviços encontrados.', '2.5.9.27139', 'Versão não informada');
      const match = versions.includes('2.5.9.27139');
      return make('server-firebird-version', 'Versão do Firebird', 'firebird', match ? 'success' : 'warning', match ? 'Versão esperada encontrada.' : 'A versão encontrada diverge da versão esperada.', '2.5.9.27139', versions.join(', '));
    }
  },
  {
    id: 'server-firebird-architecture', name: 'Arquitetura do Firebird', category: 'firebird', profiles: ['server'],
    validate: ({ installation }) => {
      if (!installation || installation.firebirdError) return make('server-firebird-architecture', 'Arquitetura do Firebird', 'firebird', 'ignored', installation?.firebirdError || 'Consulta não disponível.', 'x64', 'Não verificável');
      const values = [...new Set(installation.firebirdServices.map(s => s.architecture).filter((v): v is string => Boolean(v)))];
      if (!values.length) return make('server-firebird-architecture', 'Arquitetura do Firebird', 'firebird', 'ignored', 'A arquitetura PE dos executáveis do serviço não pôde ser identificada.', 'x64', 'Não identificada');
      const match = values.includes('x64');
      return make('server-firebird-architecture', 'Arquitetura do Firebird', 'firebird', match ? 'success' : 'warning', match ? 'Executável x64 encontrado.' : 'A arquitetura encontrada diverge de x64.', 'x64', values.join(', '));
    }
  },
  {
    id: 'server-firebird-service', name: 'Serviço do Firebird', category: 'firebird', profiles: ['server'],
    validate: ({ installation }) => {
      if (!installation || installation.firebirdError) return make('server-firebird-service', 'Serviço do Firebird', 'firebird', 'ignored', installation?.firebirdError || 'Consulta não disponível.', 'Estado do serviço consultável', 'Não verificável');
      const services = installation.firebirdServices;
      if (!services.length) return make('server-firebird-service', 'Serviço do Firebird', 'firebird', 'ignored', 'Nenhum serviço para consultar; a ausência já é apresentada na regra de instalação.', 'Serviço disponível', 'Não encontrado');
      const running = services.filter(s => s.state?.toLowerCase() === 'running');
      const actual = services.map(s => `${s.displayName || s.serviceName}: ${s.state || 'estado não informado'}`).join('; ');
      return make('server-firebird-service', 'Serviço do Firebird', 'firebird', running.length ? 'success' : 'warning', running.length ? 'Serviço do Firebird em execução.' : 'Serviço instalado, mas não está em execução.', 'Serviço em execução', actual);
    }
  },
  {
    id: 'server-cobian-installed', name: 'Cobian Backup instalado', category: 'backup', profiles: ['server'],
    validate: ({ installation }) => softwareInstalled('server-cobian-installed', 'Cobian Backup', 'backup', installation?.cobian, installation?.cobianError)
  },
  {
    id: 'server-cobian-version', name: 'Versão do Cobian Backup', category: 'backup', profiles: ['server'],
    validate: ({ installation }) => softwareVersion('server-cobian-version', 'Cobian Backup', 'backup', installation?.cobian, installation?.cobianError, '9.5.1.212')
  },
  {
    id: 'server-cobian-location', name: 'Local esperado do Cobian Backup', category: 'backup', profiles: ['server'],
    validate: ({ installation }) => {
      const apps = installation?.cobian;
      const error = installation?.cobianError;
      if (!apps) return make('server-cobian-location', 'Local esperado do Cobian Backup', 'backup', 'ignored', error || 'Local não verificável.', 'Local de instalação definido no procedimento', 'Não verificável');
      const locations = apps.map(a => a.location).filter((v): v is string => Boolean(v));
      return make('server-cobian-location', 'Local esperado do Cobian Backup', 'backup', 'ignored', locations.length ? 'O local foi localizado, mas o procedimento não define um diretório esperado para comparação.' : 'O Registro não informou o local da instalação.', 'Diretório esperado não informado', locations.join('; ') || 'Não informado');
    }
  },
  {
    id: 'server-ibconsole', name: 'IBConsole', category: 'ibconsole', profiles: ['server'],
    validate: ({ installation }) => {
      if (!installation || installation.ibconsoleError) return make('server-ibconsole', 'IBConsole', 'ibconsole', 'ignored', installation?.ibconsoleError || 'Consulta não disponível.', String.raw`C:\SoS Soluções\Troia\IBConsole.exe`, 'Não verificável');
      const expected = 'IBConsole.exe';
      const found = installation.ibconsoleExecutables.find(file => file.toLowerCase() === expected.toLowerCase());
      return make('server-ibconsole', 'IBConsole', 'ibconsole', found ? 'success' : 'error', found ? 'Executável esperado encontrado na pasta do Troia.' : 'Executável esperado não encontrado na pasta do Troia.', String.raw`C:\SoS Soluções\Troia\IBConsole.exe`, found || 'Ausente');
    }
  },
  {
    id: 'server-nuvem-contabil-installed', name: 'Nuvem Contábil instalada', category: 'cloud_accounting', profiles: ['server'],
    validate: ({ installation }) => softwareInstalled('server-nuvem-contabil-installed', 'Nuvem Contábil', 'cloud_accounting', installation?.nubeContabil, installation?.nubeContabilError)
  },
  {
    id: 'server-nuvem-contabil-version', name: 'Versão do Nuvem Contábil', category: 'cloud_accounting', profiles: ['server'],
    validate: ({ installation }) => softwareVersion('server-nuvem-contabil-version', 'Nuvem Contábil', 'cloud_accounting', installation?.nubeContabil, installation?.nubeContabilError, '1.0.29')
  },
  {
    id: 'server-nuvem-contabil-location', name: 'Local do Nuvem Contábil', category: 'cloud_accounting', profiles: ['server'],
    validate: ({ installation }) => {
      const apps = installation?.nubeContabil;
      const error = installation?.nubeContabilError;
      if (!apps) return make('server-nuvem-contabil-location', 'Local do Nuvem Contábil', 'cloud_accounting', 'ignored', error || 'Local não verificável.', 'Local de instalação informado quando disponível', 'Não verificável');
      const locations = apps.map(a => a.location).filter((v): v is string => Boolean(v));
      return locations.length ? make('server-nuvem-contabil-location', 'Local do Nuvem Contábil', 'cloud_accounting', 'success', 'Localização informada pelo Windows.', 'Local identificável', locations.join('; ')) : make('server-nuvem-contabil-location', 'Local do Nuvem Contábil', 'cloud_accounting', 'ignored', 'O Registro não informou o local de instalação.', 'Local identificável quando disponível', 'Não informado');
    }
  }
];

export const serverRules: readonly ValidationRule[] = rules;
