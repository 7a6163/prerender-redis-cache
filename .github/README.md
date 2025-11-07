# GitHub Configuration

This directory contains GitHub-specific configuration files.

## Workflows

### `workflows/test.yml`

Automated testing workflow that runs on every push and pull request.

**Features:**
- ✅ Runs tests on multiple Node.js versions (14, 16, 18, 20)
- ✅ Generates code coverage reports
- ✅ Uploads coverage to Codecov
- ✅ Uses npm cache for faster builds

**Triggers:**
- Push to `master` or `main` branch
- Pull requests targeting `master` or `main` branch

**Steps:**
1. Checkout code
2. Setup Node.js with caching
3. Install dependencies with `npm ci`
4. Run tests with `npm test`
5. Generate coverage with `npm run test:coverage`
6. Upload coverage to Codecov

## Setting Up

### Required Secrets

Add these secrets in repository Settings → Secrets → Actions:

- **`CODECOV_TOKEN`**: Token from codecov.io for uploading coverage reports
  - Get it from: https://codecov.io/gh/OWNER/REPO/settings

### Optional Configuration

You can customize the workflow by editing `workflows/test.yml`:

- **Node versions**: Modify the `matrix.node-version` array
- **Test commands**: Change the `npm test` command
- **Coverage settings**: Adjust Codecov flags and options

## Badges

The following badges are available in README.md:

- **Tests**: Shows if tests are passing
- **Coverage**: Shows current code coverage percentage
- **npm version**: Shows latest published version

Update badge URLs if you fork this repository.
