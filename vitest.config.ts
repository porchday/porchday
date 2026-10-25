import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:['apps/**/*.test.ts','scripts/**/*.test.ts'],exclude:['**/node_modules/**','**/dist/**'],testTimeout:30000,fileParallelism:false}});
