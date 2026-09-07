# Contributing to GW1 Live Trade Prices

Thank you for your interest in contributing to GW1 Live Trade Prices! This document provides guidelines for contributing to the project.

## Getting Started

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests to ensure everything works (`npm test`)
5. Submit a pull request

## Development Setup

1. Ensure you have Node.js 22.13+ or 23.4+ installed
2. Clone your fork
3. Install dependencies (if any external packages are added)
4. Run the application: `npm start`
5. Run backfill for full data: `npm run backfill`

## Code Style

- Use JavaScript modules (ESM)
- Follow the existing code structure
- Keep code DRY and maintainable
- Add comments for complex logic

## Testing

All contributions should include tests where appropriate:

```bash
npm test
```

The test suite includes:
- Alert logic tests
- Authentication tests
- Parsing logic tests
- Watcher tests
- Integration tests (the real HTTP server, actually listening, hit with real requests)

`npm run test:watch` reruns on file change; `npm run test:coverage` prints a
per-file coverage report. Both use Node's own built-in test-runner flags —
no dependency, no separate config.

## Documentation

- Update README.md for new features
- Update CHANGELOG.md with version changes
- Add inline comments for complex logic

## Pull Request Process

1. Update README.md if you add new configuration options
2. Update CHANGELOG.md with your version
3. Ensure all tests pass
4. Your PR will be reviewed and merged if approved

## Community Guidelines

- Be respectful and inclusive
- Help newcomers
- Provide constructive feedback

## Questions?

Open an issue or reach out to the project maintainers.