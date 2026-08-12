import { LocalProvider } from './localProvider';

/**
 * Test Mode reuses the proven local business behavior, while the bootstrap
 * storage router sends every database operation to the isolated Test DB.
 */
export class TestSandboxProvider extends LocalProvider {
  override async canWriteCloud(): Promise<boolean> {
    return false;
  }
}

export const testSandboxProvider = new TestSandboxProvider();
