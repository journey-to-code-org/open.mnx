import { Config } from '@stencil/core';
import { reactOutputTarget } from '@stencil/react-output-target';
import { vueOutputTarget } from '@stencil/vue-output-target';

// One build writes the elements (dist/components), the server renderer (hydrate/) and the React
// and Vue components (generated/).
export const config: Config = {
  namespace: 'coexist',
  srcDir: 'src',
  tsconfig: 'tsconfig.json',
  validateTypes: false,
  outputTargets: [
    { type: 'dist-custom-elements', dir: 'dist/components', customElementsExportBehavior: 'auto-define-custom-elements', externalRuntime: false },
    { type: 'dist-hydrate-script', dir: 'hydrate' },
    reactOutputTarget({ outDir: 'generated/react', customElementsDir: 'dist/components' }),
    vueOutputTarget({
      proxiesFile: 'generated/vue/components.ts',
      componentCorePackage: 'coexist-stencil',
      includeImportCustomElements: true,
      customElementsDir: 'dist/components',
      componentModels: [{ elements: ['ds-field', 'ds-quantity'], event: 'valuechange', targetAttr: 'value' }],
    }),
  ],
};
