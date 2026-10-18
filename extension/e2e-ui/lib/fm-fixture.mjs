// Starts the mock under a neutral file name. Other tools and agents on a shared machine clean up with
// `pkill -f mock-server`, which would end a mock that the UI tests are using mid-run.
import { main } from '../../test/mock-server/server.mjs';

await main();
