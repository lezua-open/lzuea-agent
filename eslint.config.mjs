import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

/**
 * ESLint 扁平配置。
 *
 * 分层：JS 推荐规则 → TS 推荐规则 → 项目规则 → Prettier 收尾（关掉所有格式类规则）。
 * 类型感知的规则（no-floating-promises 等）刻意没开 —— 它们要多跑一次 tsc，
 * 和 typecheck 脚本重复。类型错误交给 tsc，这里只管代码卫生。
 */
export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'drizzle/**',
      '.dev/**',
      '*.config.ts',
      '*.config.mjs',
      'src/preload/index.d.ts'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module'
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      // core 层要能被单测，不能偷偷读全局状态；platform 层才允许 console
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': ['error', 'properties'],
      'no-implicit-coercion': ['error', { boolean: false }]
    }
  },
  {
    // 平台层和工具脚本直接打日志是合理的
    files: ['src/main/**/*', 'scripts/**/*'],
    rules: { 'no-console': 'off' }
  },
  {
    // scripts/ 下是纯 Node 的 .mjs（不是 TS），tseslint 关不掉的 no-undef 要靠全局表解决
    files: ['scripts/**/*'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, WebSocket: 'readonly' }
    }
  },
  {
    // 渲染层的 console 也放开，调试 UI 很常见
    files: ['src/renderer/**/*'],
    rules: { 'no-console': 'off' }
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off'
    }
  }
)
