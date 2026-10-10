'use strict';
// Deterministic repository scanner used by /factory-init. It reports facts and
// suggestions; the init agent reviews them, fills gaps, then applies them.

const fs = require('fs');
const path = require('path');
const { paths, git, which, sh, readText } = require('./util');

const IGNORE = new Set([
  '.git', 'node_modules', '.venv', 'venv', 'env', '__pycache__', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', 'coverage', 'vendor', '.idea', '.vscode',
  'Pods', '.gradle', '.dart_tool', 'obj', 'tmp', '.terraform', '.claude',
]);

// Walk up to `maxDepth` levels, skipping ignored and hidden dirs (except .github).
function walk(root, maxDepth = 4) {
  const files = [];
  const dirs = [];
  const visit = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const relp = path.relative(root, abs);
      if (e.isDirectory()) {
        if (IGNORE.has(e.name) || (e.name.startsWith('.') && e.name !== '.github')) continue;
        if (fs.existsSync(path.join(abs, 'bin', 'factory-cli.js'))) continue; // the factory package itself
        dirs.push(relp);
        if (depth < maxDepth) visit(abs, depth + 1);
      } else if (e.isFile()) files.push(relp);
      if (files.length > 20000) return;
    }
  };
  visit(root, 0);
  return { files, dirs };
}

const readJSONSafe = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const uniq = (a) => [...new Set(a.filter(Boolean))];

const FRONTEND_DEPS = {
  react: 'React', 'react-dom': 'React', next: 'Next.js', vue: 'Vue', nuxt: 'Nuxt', svelte: 'Svelte',
  '@sveltejs/kit': 'SvelteKit', '@angular/core': 'Angular', 'solid-js': 'Solid', preact: 'Preact',
  astro: 'Astro', '@remix-run/react': 'Remix', lit: 'Lit', 'ember-source': 'Ember', 'alpinejs': 'Alpine',
  'htmx.org': 'htmx', qwik: 'Qwik', '@builder.io/qwik': 'Qwik', gatsby: 'Gatsby', vite: 'Vite',
};
const MOBILE_DEPS = { 'react-native': 'React Native', expo: 'Expo', '@capacitor/core': 'Capacitor', '@ionic/core': 'Ionic' };
const DESKTOP_DEPS = { electron: 'Electron', '@tauri-apps/api': 'Tauri' };
const DB_DEPS = {
  prisma: 'Prisma', '@prisma/client': 'Prisma', 'drizzle-orm': 'Drizzle', typeorm: 'TypeORM', sequelize: 'Sequelize',
  mongoose: 'MongoDB/Mongoose', mongodb: 'MongoDB', knex: 'Knex', pg: 'PostgreSQL', mysql2: 'MySQL',
  'better-sqlite3': 'SQLite', '@mikro-orm/core': 'MikroORM', kysely: 'Kysely', firebase: 'Firebase',
  'firebase-admin': 'Firebase', '@supabase/supabase-js': 'Supabase', redis: 'Redis', ioredis: 'Redis',
  '@planetscale/database': 'PlanetScale', 'objection': 'Objection',
};
const PY_DB = ['sqlalchemy', 'django', 'alembic', 'peewee', 'tortoise-orm', 'psycopg', 'psycopg2', 'pymongo', 'sqlmodel', 'asyncpg', 'prisma'];
const PY_WEB = { django: 'Django', flask: 'Flask', fastapi: 'FastAPI', streamlit: 'Streamlit', 'reflex': 'Reflex' };

function detect() {
  const p = paths();
  const root = p.root;
  const { files, dirs } = walk(root);
  const has = (f) => fs.existsSync(path.join(root, f));
  const read = (f) => readText(path.join(root, f)) || '';
  const fileSet = new Set(files);
  const anyFile = (re) => files.filter((f) => re.test(f));
  const evidence = [];

  const languages = [];
  const packageManagers = [];
  const frameworks = [];
  const commands = {};
  const hints = { ci: [], makeTargets: [], scripts: {} };

  // ------------------------------------------------------------ JS / TS
  const pkg = readJSONSafe(path.join(root, 'package.json'));
  const pkgFiles = anyFile(/(^|\/)package\.json$/);
  const allDeps = {};
  for (const f of pkgFiles) {
    const j = readJSONSafe(path.join(root, f));
    if (j) Object.assign(allDeps, j.dependencies, j.devDependencies, j.peerDependencies);
  }
  let pm = null;
  if (pkg || pkgFiles.length) {
    languages.push(has('tsconfig.json') || anyFile(/(^|\/)tsconfig\.json$/).length || allDeps.typescript ? 'TypeScript' : 'JavaScript');
    if (has('pnpm-lock.yaml') || has('pnpm-workspace.yaml')) pm = 'pnpm';
    else if (has('bun.lockb') || has('bun.lock')) pm = 'bun';
    else if (has('yarn.lock')) pm = 'yarn';
    else if (has('package-lock.json')) pm = 'npm';
    else if (pkg && pkg.packageManager) pm = pkg.packageManager.split('@')[0];
    else pm = 'npm';
    packageManagers.push(pm);
    const run = (s) => (pm === 'npm' ? `npm run ${s}` : pm === 'yarn' ? `yarn ${s}` : `${pm} run ${s}`);
    commands.setup = {
      pnpm: 'pnpm install --frozen-lockfile', yarn: has('.yarnrc.yml') ? 'yarn install --immutable' : 'yarn install --frozen-lockfile',
      bun: 'bun install', npm: has('package-lock.json') ? 'npm ci' : 'npm install',
    }[pm] || `${pm} install`;
    const scripts = (pkg && pkg.scripts) || {};
    hints.scripts = scripts;
    const pick = (...names) => names.find((n) => scripts[n]);
    const map = {
      test: pick('test:ci', 'test:unit', 'test'), lint: pick('lint'), build: pick('build'),
      typecheck: pick('typecheck', 'type-check', 'tsc', 'check-types', 'check'), format: pick('format:check', 'format', 'prettier'),
      dev: pick('dev', 'start', 'serve'),
    };
    for (const [k, s] of Object.entries(map)) {
      if (!s) continue;
      if (k === 'test' && /no test specified/.test(scripts[s])) continue;
      commands[k] = run(s);
    }
    // Give parallel jobs their own dev-server port when the dev tool takes --port.
    if (map.dev && /\b(vite|next|astro|nuxt|svelte-kit|remix|webpack(-dev-server| serve)|ng serve|vue-cli-service serve|react-scripts start)\b/.test(scripts[map.dev]) && !/port/i.test(scripts[map.dev])) {
      commands.dev += /react-scripts/.test(scripts[map.dev]) ? '' : `${pm === 'npm' ? ' --' : ''} --port {port}`;
      if (/react-scripts/.test(scripts[map.dev])) commands.dev = `PORT={port} ${commands.dev}`;
    }
    if (!commands.typecheck && languages.includes('TypeScript') && allDeps.typescript) commands.typecheck = pm === 'npm' ? 'npx tsc --noEmit' : `${pm} exec tsc --noEmit`;
    evidence.push(`package.json (${pm})`);
  }

  // ------------------------------------------------------------ Python
  const pyproject = read('pyproject.toml');
  const requirements = read('requirements.txt') + read('requirements-dev.txt') + read('requirements/base.txt');
  if (pyproject || requirements || has('setup.py') || has('Pipfile') || anyFile(/(^|\/)pyproject\.toml$/).length) {
    languages.push('Python');
    let ppm = 'pip';
    if (has('uv.lock')) ppm = 'uv';
    else if (has('poetry.lock') || /\[tool\.poetry\]/.test(pyproject)) ppm = 'poetry';
    else if (has('pdm.lock')) ppm = 'pdm';
    else if (has('Pipfile')) ppm = 'pipenv';
    else if (has('hatch.toml') || /\[tool\.hatch/.test(pyproject)) ppm = 'hatch';
    packageManagers.push(ppm);
    const exec = { uv: 'uv run ', poetry: 'poetry run ', pdm: 'pdm run ', pipenv: 'pipenv run ', hatch: 'hatch run ', pip: '' }[ppm];
    commands.setup ||= {
      uv: 'uv sync', poetry: 'poetry install', pdm: 'pdm install', pipenv: 'pipenv install --dev', hatch: 'hatch env create',
      pip: has('requirements.txt') ? 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt' : 'python3 -m venv .venv && .venv/bin/pip install -e .',
    }[ppm];
    const text = (pyproject + requirements).toLowerCase();
    if (/pytest/.test(text) || has('pytest.ini') || has('conftest.py') || anyFile(/(^|\/)test_[^/]+\.py$/).length) commands.test ||= `${exec}pytest`;
    else if (dirs.includes('tests')) commands.test ||= `${exec}python -m unittest discover`;
    if (/ruff/.test(text) || has('ruff.toml') || has('.ruff.toml')) {
      commands.lint ||= `${exec}ruff check .`;
      commands.format ||= `${exec}ruff format --check .`;
    } else if (/flake8/.test(text)) commands.lint ||= `${exec}flake8`;
    if (/mypy/.test(text) || has('mypy.ini')) commands.typecheck ||= `${exec}mypy .`;
    else if (/pyright/.test(text)) commands.typecheck ||= `${exec}pyright`;
    if (/black/.test(text) && !commands.format) commands.format = `${exec}black --check .`;
    for (const [dep, name] of Object.entries(PY_WEB)) if (new RegExp(`(^|[^a-z-])${dep}([^a-z-]|$)`).test(text)) frameworks.push(name);
    if (has('manage.py')) {
      frameworks.push('Django');
      commands.dev ||= `${exec}python manage.py runserver {port}`;
      if (!/pytest/.test(text)) commands.test ||= `${exec}python manage.py test`;
    }
    evidence.push(`Python (${ppm})`);
  }

  // ------------------------------------------------------------ Others
  const simple = [
    ['go.mod', 'Go', 'go', { setup: 'go mod download', build: 'go build ./...', test: 'go test ./...', lint: has('.golangci.yml') || has('.golangci.yaml') ? 'golangci-lint run' : 'go vet ./...', format: 'test -z "$(gofmt -l .)"' }],
    ['Cargo.toml', 'Rust', 'cargo', { setup: 'cargo fetch', build: 'cargo build', test: 'cargo test', lint: 'cargo clippy -- -D warnings', format: 'cargo fmt --check' }],
    ['pom.xml', 'Java', 'maven', { setup: has('mvnw') ? './mvnw -q dependency:resolve' : 'mvn -q dependency:resolve', build: has('mvnw') ? './mvnw -q package -DskipTests' : 'mvn -q package -DskipTests', test: has('mvnw') ? './mvnw test' : 'mvn test' }],
    ['build.gradle', 'Java/Kotlin', 'gradle', { build: has('gradlew') ? './gradlew build -x test' : 'gradle build -x test', test: has('gradlew') ? './gradlew test' : 'gradle test', lint: has('gradlew') ? './gradlew check -x test' : null }],
    ['build.gradle.kts', 'Kotlin', 'gradle', { build: has('gradlew') ? './gradlew build -x test' : 'gradle build -x test', test: has('gradlew') ? './gradlew test' : 'gradle test' }],
    ['Gemfile', 'Ruby', 'bundler', { setup: 'bundle install', test: has('bin/rails') ? 'bin/rails test' : has('.rspec') ? 'bundle exec rspec' : 'bundle exec rake test', lint: has('.rubocop.yml') ? 'bundle exec rubocop' : null, dev: has('bin/rails') ? 'bin/rails server -p {port}' : null }],
    ['composer.json', 'PHP', 'composer', { setup: 'composer install', test: has('artisan') ? 'php artisan test' : 'vendor/bin/phpunit', dev: has('artisan') ? 'php artisan serve --port={port}' : null }],
    ['mix.exs', 'Elixir', 'mix', { setup: 'mix deps.get', test: 'mix test', lint: 'mix credo', format: 'mix format --check-formatted', dev: has('config/dev.exs') ? 'PORT={port} mix phx.server' : null }],
    ['pubspec.yaml', 'Dart', 'pub', { setup: 'flutter pub get', test: 'flutter test', lint: 'flutter analyze' }],
    ['Package.swift', 'Swift', 'swiftpm', { build: 'swift build', test: 'swift test' }],
    ['deno.json', 'TypeScript', 'deno', { test: 'deno test', lint: 'deno lint', format: 'deno fmt --check' }],
  ];
  for (const [marker, lang, mgr, cmds] of simple) {
    if (!has(marker)) continue;
    languages.push(lang);
    packageManagers.push(mgr);
    for (const [k, v] of Object.entries(cmds)) if (v) commands[k] ||= v;
    evidence.push(marker);
  }
  if (anyFile(/\.(csproj|sln|fsproj)$/).length) {
    languages.push('C#/.NET');
    packageManagers.push('dotnet');
    Object.entries({ setup: 'dotnet restore', build: 'dotnet build --no-restore', test: 'dotnet test', format: 'dotnet format --verify-no-changes' })
      .forEach(([k, v]) => (commands[k] ||= v));
  }
  if (has('CMakeLists.txt')) languages.push('C/C++');

  // ------------------------------------------------------------ Task runners
  const makefile = read('Makefile') || read('makefile');
  if (makefile) {
    const targets = uniq([...makefile.matchAll(/^([a-zA-Z][\w-]*)\s*:(?!=)/gm)].map((m) => m[1]));
    hints.makeTargets = targets;
    for (const k of ['test', 'lint', 'build', 'format', 'typecheck', 'setup', 'install', 'dev']) {
      const key = k === 'install' ? 'setup' : k;
      if (targets.includes(k) && !commands[key]) commands[key] = `make ${k}`;
    }
  }
  const justfile = read('justfile') || read('Justfile');
  if (justfile) {
    const recipes = uniq([...justfile.matchAll(/^([a-zA-Z][\w-]*)[^\n:=]*:(?!=)/gm)].map((m) => m[1]));
    hints.justRecipes = recipes;
    for (const k of ['test', 'lint', 'build', 'format', 'dev']) if (recipes.includes(k) && !commands[k]) commands[k] = `just ${k}`;
  }

  // ------------------------------------------------------------ CI hints
  for (const f of anyFile(/^\.github\/workflows\/[^/]+\.ya?ml$/).concat(fileSet.has('.gitlab-ci.yml') ? ['.gitlab-ci.yml'] : [])) {
    const runs = [...read(f).matchAll(/^\s*(?:-\s*)?(?:run|script):\s*\|?\s*(.+)$/gm)].map((m) => m[1].trim()).filter((r) => r && r !== '|');
    hints.ci.push(...runs.slice(0, 20).map((r) => `${f}: ${r}`));
  }

  // ------------------------------------------------------------ Monorepo
  let mono = { enabled: false, tool: null, packages: [] };
  const wsPatterns = [];
  if (has('pnpm-workspace.yaml')) {
    mono.tool = 'pnpm-workspaces';
    wsPatterns.push(...[...read('pnpm-workspace.yaml').matchAll(/^\s*-\s*['"]?([^'"\n]+)['"]?/gm)].map((m) => m[1]));
  }
  if (pkg && pkg.workspaces) {
    mono.tool ||= `${pm}-workspaces`;
    wsPatterns.push(...(Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages || []));
  }
  for (const [file, tool] of [['nx.json', 'nx'], ['turbo.json', 'turborepo'], ['lerna.json', 'lerna'], ['rush.json', 'rush'], ['go.work', 'go-workspace']]) {
    if (has(file)) mono.tool = mono.tool ? `${mono.tool}+${tool}` : tool;
  }
  if (/^\s*\[workspace\]/m.test(read('Cargo.toml'))) {
    mono.tool ||= 'cargo-workspace';
    const m = read('Cargo.toml').match(/members\s*=\s*\[([^\]]*)\]/s);
    if (m) wsPatterns.push(...[...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  }
  if (has('settings.gradle') || has('settings.gradle.kts')) {
    const inc = [...(read('settings.gradle') + read('settings.gradle.kts')).matchAll(/include\s*\(?\s*['"]:?([^'"]+)['"]/g)].map((m) => m[1].replace(/:/g, '/'));
    if (inc.length > 1) {
      mono.tool ||= 'gradle-multiproject';
      mono.packages.push(...inc);
    }
  }
  if (/<modules>/.test(read('pom.xml'))) {
    mono.tool ||= 'maven-modules';
    mono.packages.push(...[...read('pom.xml').matchAll(/<module>([^<]+)<\/module>/g)].map((m) => m[1]));
  }
  for (const pat of wsPatterns) {
    if (pat.startsWith('!')) continue;
    const re = new RegExp(`^${pat.replace(/\/$/, '').replace(/\*\*/g, '.+').replace(/\*/g, '[^/]+')}$`);
    mono.packages.push(...dirs.filter((d) => re.test(d) && (fileSet.has(`${d}/package.json`) || fileSet.has(`${d}/Cargo.toml`) || fileSet.has(`${d}/go.mod`))));
  }
  if (!mono.tool) {
    const nested = anyFile(/^[^/]+\/[^/]+\/(package\.json|pyproject\.toml|go\.mod|Cargo\.toml)$|^[^/]+\/(package\.json|pyproject\.toml|go\.mod|Cargo\.toml)$/);
    if (nested.length >= 2) {
      mono.tool = 'multi-package (no workspace tool)';
      mono.packages = nested.map((f) => path.dirname(f));
    }
  }
  mono.packages = uniq(mono.packages).sort();
  mono.enabled = Boolean(mono.tool) && (mono.packages.length >= 2 || /nx|turbo|lerna|rush/.test(mono.tool));

  // ------------------------------------------------------------ Frontend
  const fe = { kind: 'none', frameworks: [], paths: [] };
  for (const [dep, name] of Object.entries(FRONTEND_DEPS)) if (allDeps[dep]) fe.frameworks.push(name);
  const mobile = Object.entries(MOBILE_DEPS).filter(([d]) => allDeps[d]).map(([, n]) => n);
  const desktop = Object.entries(DESKTOP_DEPS).filter(([d]) => allDeps[d]).map(([, n]) => n);
  const tmplFiles = anyFile(/\.(html|erb|blade\.php|jinja2?|j2|hbs|ejs|njk|twig|heex|vue|svelte|tsx|jsx|astro)$/);
  const webTemplateDirs = uniq(tmplFiles.map((f) => path.dirname(f).split('/').slice(0, 2).join('/')).filter((d) => !/^(test|tests|spec|docs?|examples?)\b/.test(d)));
  if (fe.frameworks.filter((f) => f !== 'Vite').length || frameworks.some((f) => /Django|Flask|Rails|FastAPI|Streamlit/.test(f)) || has('bin/rails') || has('artisan')) {
    fe.kind = 'web';
  } else if (tmplFiles.filter((f) => /\.(html|erb|blade\.php|jinja2?|hbs|ejs|njk|twig|heex)$/.test(f)).length >= 2) {
    fe.kind = 'web';
    fe.frameworks.push('server-rendered templates');
  }
  if (mobile.length || has('pubspec.yaml') || anyFile(/\.xcodeproj\//).length || has('android/app/build.gradle')) {
    fe.kind = fe.kind === 'web' ? 'web' : 'mobile';
    fe.frameworks.push(...mobile, ...(has('pubspec.yaml') ? ['Flutter'] : []));
  }
  if (desktop.length) {
    fe.kind = fe.kind === 'none' ? 'desktop' : fe.kind;
    fe.frameworks.push(...desktop);
  }
  fe.frameworks = uniq(fe.frameworks);
  if (fe.kind !== 'none') fe.paths = webTemplateDirs.slice(0, 12);
  frameworks.push(...fe.frameworks.filter((f) => f !== 'server-rendered templates'));

  // ------------------------------------------------------------ Database
  const db = { detected: false, technologies: [], paths: [] };
  for (const [dep, name] of Object.entries(DB_DEPS)) if (allDeps[dep]) db.technologies.push(name);
  const pyText = (pyproject + requirements).toLowerCase();
  for (const dep of PY_DB) if (new RegExp(`(^|[^a-z-])${dep}([^a-z-]|$)`).test(pyText)) db.technologies.push(dep === 'django' ? 'Django ORM' : dep);
  const goMod = read('go.mod');
  for (const [dep, name] of [['gorm.io', 'GORM'], ['jmoiron/sqlx', 'sqlx'], ['jackc/pgx', 'pgx'], ['ent', 'ent'], ['database/sql', 'database/sql'], ['golang-migrate', 'golang-migrate']]) {
    if (goMod.includes(dep) && dep !== 'ent') db.technologies.push(name);
  }
  const cargo = read('Cargo.toml');
  for (const dep of ['diesel', 'sqlx', 'sea-orm', 'rusqlite', 'tokio-postgres']) if (new RegExp(`^${dep}\\s*=`, 'm').test(cargo)) db.technologies.push(dep);
  if (/spring-boot-starter-data-(jpa|jdbc|mongodb)|hibernate|flyway|liquibase/.test(read('pom.xml') + read('build.gradle') + read('build.gradle.kts'))) db.technologies.push('JPA/JDBC');
  if (has('bin/rails') || has('db/schema.rb')) db.technologies.push('ActiveRecord');
  if (/ecto/.test(read('mix.exs'))) db.technologies.push('Ecto');
  const dbPathRe = /(^|\/)(migrations?|alembic|db\/migrate|prisma|drizzle|supabase\/migrations|schema\.prisma|firestore\.rules|schema\.sql|flyway|liquibase|seeds?)(\/|$)/i;
  db.paths = uniq(dirs.filter((d) => dbPathRe.test(d)).concat(files.filter((f) => /(schema\.prisma|drizzle\.config\.\w+|alembic\.ini|firestore\.rules|database\.rules\.json|schema\.sql|db\/schema\.rb|ormconfig\.\w+|knexfile\.\w+)$/.test(f)))).slice(0, 15);
  db.technologies = uniq(db.technologies);
  db.detected = db.technologies.length > 0 || db.paths.length > 0 || anyFile(/\.sql$/).length >= 2;

  // ------------------------------------------------------------ Git
  const gitInfo = { baseBranch: null, remote: null, remoteUrl: null, isGitHub: false, branchPrefixes: {}, commitStyle: 'free', dirty: false };
  if (p.isGit) {
    const remotes = (git(['remote'], { cwd: root, allowFail: true }) || '').split('\n').filter(Boolean);
    gitInfo.remote = remotes.includes('origin') ? 'origin' : remotes[0] || null;
    if (gitInfo.remote) {
      gitInfo.remoteUrl = git(['remote', 'get-url', gitInfo.remote], { cwd: root, allowFail: true });
      gitInfo.isGitHub = /github\.com[:/]/.test(gitInfo.remoteUrl || '');
      const head = git(['symbolic-ref', '--short', `refs/remotes/${gitInfo.remote}/HEAD`], { cwd: root, allowFail: true });
      if (head) gitInfo.baseBranch = head.replace(`${gitInfo.remote}/`, '');
    }
    const locals = (git(['branch', '--format=%(refname:short)'], { cwd: root, allowFail: true }) || '').split('\n').filter(Boolean);
    if (!gitInfo.baseBranch) gitInfo.baseBranch = ['main', 'master', 'trunk', 'develop'].find((b) => locals.includes(b)) || git(['branch', '--show-current'], { cwd: root, allowFail: true }) || 'main';
    const allBranches = (git(['branch', '-a', '--format=%(refname:short)'], { cwd: root, allowFail: true }) || '').split('\n');
    for (const b of allBranches) {
      const m = b.replace(/^[^/]+\/(?=.+\/)/, '').match(/^([a-z]+)[/-]/i);
      if (m && !['origin', 'HEAD'].includes(m[1])) gitInfo.branchPrefixes[m[1]] = (gitInfo.branchPrefixes[m[1]] || 0) + 1;
    }
    const subjects = (git(['log', '-50', '--format=%s'], { cwd: root, allowFail: true }) || '').split('\n').filter(Boolean);
    const conventional = subjects.filter((s) => /^(feat|fix|chore|docs|refactor|test|perf|build|ci|style)(\(.+\))?!?:/.test(s)).length;
    gitInfo.commitStyle = subjects.length && conventional / subjects.length >= 0.4 ? 'conventional' : 'free';
    gitInfo.commits = subjects.length;
    gitInfo.dirty = Boolean(git(['status', '--porcelain'], { cwd: root, allowFail: true }));
  }

  // ------------------------------------------------------------ Tools
  const ghPath = which('gh');
  const tools = {
    git: Boolean(which('git')),
    gh: Boolean(ghPath) && sh('gh auth status', { timeoutMs: 8000 }).ok,
    ghInstalled: Boolean(ghPath),
    browser: which('agent-browser') ? 'agent-browser' : (allDeps['@playwright/test'] || allDeps.playwright || which('playwright')) ? 'playwright' : null,
    docker: Boolean(which('docker')),
  };

  // ------------------------------------------------------------ Agent guidance
  const guidance = ['CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md', '.cursorrules', 'CONTRIBUTING.md'].filter(has);

  const isArchitecture = mono.enabled;
  const suggestion = {
    reviewers: {
      code: { enabled: true, reason: 'universal' },
      security: { enabled: true, reason: 'universal' },
      'ui-ux': fe.kind === 'none'
        ? { enabled: false, reason: 'no user-facing UI detected' }
        : { enabled: true, mode: fe.kind === 'web' && tools.browser ? 'browser' : 'static', reason: `${fe.kind} UI: ${fe.frameworks.join(', ') || 'templates'}${fe.kind === 'web' && !tools.browser ? ' (no browser CLI → static review)' : ''}` },
      database: db.detected
        ? { enabled: true, reason: `database: ${db.technologies.join(', ') || db.paths.join(', ')}` }
        : { enabled: false, reason: 'no database, ORM or migrations detected' },
      architecture: isArchitecture
        ? { enabled: true, reason: `${mono.tool} with ${mono.packages.length} packages` }
        : { enabled: false, reason: 'single-package repository' },
    },
    delivery: tools.gh && gitInfo.isGitHub ? 'github-pr' : 'direct-merge',
    branchPattern: 'factory/{id}',
  };

  return {
    root,
    project: {
      name: (pkg && pkg.name) || path.basename(root),
      languages: uniq(languages),
      packageManagers: uniq(packageManagers),
      frameworks: uniq(frameworks),
      monorepo: mono,
      frontend: fe,
      database: db,
    },
    commands: Object.fromEntries(['setup', 'build', 'test', 'lint', 'typecheck', 'format', 'dev'].map((k) => [k, commands[k] || null])),
    git: gitInfo,
    tools,
    guidance,
    hints,
    evidence,
    suggestion,
    stats: { files: files.length, dirs: dirs.length },
  };
}

module.exports = { detect };
