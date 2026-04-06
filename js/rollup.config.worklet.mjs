import { nodeResolve } from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import esbuild from 'rollup-plugin-esbuild';

export default {
  input: 'src/worklet/RNNoiseWorklet.ts',
  output: {
    file: 'dist/rnnoise.denoise.worklet.js',
    format: 'iife',
    strict: true,
    sourcemap: true,
    name: 'RNNoiseDenoiseWorkletBootstrap',
    plugins: [terser()],
  },
  plugins: [
    esbuild({
      tsconfig: './src/worklet/tsconfig.json',
      target: 'es2020',
      minify: false,
    }),
    nodeResolve({ browser: true }),
  ],
};
