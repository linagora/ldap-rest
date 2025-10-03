# Development

## Running the application

**Start in development mode** (loads all available plugins automatically):

```bash
source ~/.test-env && npm run start:dev
```

## Running tests

**All tests** (also builds the project):

```bash
source ~/.test-env && npm run test:dev
```

**Single test file:**

```bash
source ~/.test-env && npm run test:one path/to/file.test.ts
```

The `source ~/.test-env` command loads the test environment variables.
