# Contributing to Safebots Infrastructure

Thank you for your interest in contributing to Safebots Infrastructure! This document provides guidelines for contributing to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How to Contribute](#how-to-contribute)
- [Pull Request Process](#pull-request-process)
- [Component Development](#component-development)
- [Testing](#testing)
- [Documentation](#documentation)

---

## Code of Conduct

This project adheres to a code of conduct. By participating, you are expected to uphold this code:

- Be respectful and inclusive
- Welcome newcomers and help them learn
- Focus on what is best for the community
- Show empathy towards other community members

---

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/your-username/Infrastructure.git
   cd Infrastructure/aws
   ```
3. **Add upstream remote**:
   ```bash
   git remote add upstream https://github.com/Safebots/Infrastructure.git
   ```

---

## Development Setup

### Prerequisites

- AWS account with EC2 access
- Amazon Linux 2023 or compatible system
- Root/sudo access
- Git, bash, jq installed

### Install Development Dependencies

```bash
./scripts/install-dev-deps.sh
```

### Build Test AMI

```bash
# Build smallest configuration for testing
sudo ./scripts/build-ami.sh base,llm-tiny
```

---

## How to Contribute

### Reporting Bugs

1. Check if the bug has already been reported in [Issues](https://github.com/safebox/safebox-ami-spec/issues)
2. If not, create a new issue with:
   - Clear title and description
   - Steps to reproduce
   - Expected vs actual behavior
   - System information (AMI version, instance type)
   - Relevant logs

### Suggesting Enhancements

1. Check [Discussions](https://github.com/safebox/safebox-ami-spec/discussions) for existing suggestions
2. Create a new discussion with:
   - Clear use case description
   - Proposed solution
   - Alternatives considered
   - Impact on existing functionality

### Adding New Components

See [Component Development](#component-development) below.

---

## Pull Request Process

1. **Create a feature branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**:
   - Follow existing code style
   - Add tests if applicable
   - Update documentation

3. **Test your changes**:
   ```bash
   ./scripts/run-tests.sh
   ```

4. **Commit with clear messages**:
   ```bash
   git commit -m "Add: Brief description of changes"
   ```
   
   Commit message prefixes:
   - `Add:` New feature or component
   - `Fix:` Bug fix
   - `Docs:` Documentation changes
   - `Refactor:` Code refactoring
   - `Test:` Test additions or changes

5. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```

6. **Create Pull Request** on GitHub:
   - Clear title and description
   - Reference any related issues
   - Describe testing performed
   - Include screenshots if UI changes

7. **Address review feedback**:
   - Make requested changes
   - Push updates to the same branch
   - Respond to reviewer comments

---

## Component Development

### Creating a New Component

1. **Create component directory**:
   ```bash
   mkdir -p scripts/components/your-component
   ```

2. **Create installer script**:
   ```bash
   # scripts/components/your-component/install-your-component.sh
   #!/bin/bash
   set -euo pipefail
   
   echo "Installing your-component..."
   
   # Install dependencies
   dnf install -y package1 package2
   
   # Install binaries/models
   cd /opt/safebox
   # ... installation logic ...
   
   # Generate manifest
   cat > /opt/safebox/manifests/your-component.json << 'EOF'
   {
     "component": {
       "name": "your-component",
       "version": "1.0.0",
       "license": ["Apache-2.0"],
       "disk": "X GB"
     },
     "capabilities": {
       "Safebox/capability/your/capability": {
         "provider": "com.safebox.local",
         "runtime": "your-runtime"
       }
     }
   }
   EOF
   
   echo "✅ your-component installed"
   ```

3. **Make it executable**:
   ```bash
   chmod +x scripts/components/your-component/install-your-component.sh
   ```

4. **Add documentation**:
   ```bash
   # docs/COMPONENT-YOUR-COMPONENT.md
   ```

5. **Add tests**:
   ```bash
   # scripts/tests/test-your-component.sh
   ```

### Component Requirements

- ✅ Must generate manifest JSON
- ✅ Must use permissive licenses (Apache 2.0, MIT, BSD)
- ✅ Must be idempotent (can run multiple times safely)
- ✅ Must include error handling
- ✅ Must document disk usage
- ✅ Must validate dependencies

---

## Testing

### Running Tests

```bash
# Run all tests
./scripts/run-tests.sh

# Run specific component test
./scripts/tests/test-llm-medium.sh

# Run integration tests
./scripts/tests/test-integration.sh
```

### Writing Tests

Create test script in `scripts/tests/`:

```bash
#!/bin/bash
set -euo pipefail

echo "Testing your-component..."

# Test installation
if [[ ! -f /opt/safebox/manifests/your-component.json ]]; then
    echo "ERROR: Manifest not found"
    exit 1
fi

# Test functionality
if ! your-command --test; then
    echo "ERROR: Functionality test failed"
    exit 1
fi

echo "✅ your-component tests passed"
```

---

## Documentation

### Documentation Standards

1. **All new features** require documentation
2. **Update README.md** if adding components
3. **Create detailed docs** in `docs/` for complex features
4. **Include examples** for all new functionality
5. **Keep table of contents** up to date

### Documentation Structure

```
docs/
├── COMPONENT-*.md       # Component-specific docs
├── ARCHITECTURE-*.md    # Architecture specs
├── LICENSE-*.md         # License information
└── *.md                 # Feature-specific docs
```

### Writing Style

- Clear, concise language
- Code examples for all features
- Screenshots/diagrams where helpful
- Links to related documentation
- Version compatibility notes

---

## License

By contributing to Safebots Infrastructure, you agree that your contributions will be licensed under the Apache 2.0 License.

---

## Questions?

- 💬 [GitHub Discussions](https://github.com/Safebots/Infrastructure/discussions)
- 📧 Email: developers@safebots.com
- 📖 Documentation: [docs/](docs/)

Thank you for contributing to Safebots Infrastructure! 🎉
