import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './ui', workers:1, timeout:30000,
  use:{baseURL:'http://127.0.0.1:4322',viewport:{width:1440,height:900}},
  webServer:{command:'npm run build && node src/main.ts',url:'http://127.0.0.1:4322',reuseExistingServer:false,env:{PORT:'4322',TAILOR_DATA_PATH:'.local/ui-test.sqlite',TAILOR_DEV_KEY:'local-review-key',TAILOR_PROVIDER:'mock',TAILOR_TELEMETRY:'captured'}},
});
