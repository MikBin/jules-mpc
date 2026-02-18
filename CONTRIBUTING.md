# Contributing to Jules Manager

First off, thank you for considering contributing to Jules Manager! We welcome contributions from everyone.

## Getting Started

1.  **Fork the repository** on GitHub.
2.  **Clone your fork** locally:
    ```bash
    git clone https://github.com/YOUR-USERNAME/jules-mpc-ts.git
    cd jules-mpc-ts
    ```
3.  **Create a branch** for your feature or bug fix:
    ```bash
    git checkout -b feature/your-feature-name
    ```

## Development Guidelines

The repository is organized into two main projects:
*   `jules-mpc-python`: Python implementation.
*   `jules-mpc-ts`: TypeScript implementation.

### Python Project (`jules-mpc-python`)

Navigate to the directory:
```bash
cd jules-mpc-python
```

*   **Environment**: Python 3.8+ is required.
*   **Dependencies**: The project relies solely on the Python standard library. No `pip install` is needed.
*   **Testing**: Currently, there are no automated tests. Verification involves running the scripts directly (e.g., `python scripts/jules_monitor.py`). Please ensure your changes do not break existing functionality.
*   **Style**: Follow PEP 8 guidelines. Use `snake_case` for functions and variables, and `UpperCamelCase` for classes.

### TypeScript Project (`jules-mpc-ts`)

Navigate to the directory:
```bash
cd jules-mpc-ts
```

*   **Environment**: Node.js 20+ is required.
*   **Setup**: Install dependencies using:
    ```bash
    npm install
    ```
*   **Building**: Compile the TypeScript code with:
    ```bash
    npm run build
    ```
*   **Testing**: Run the test suite using Vitest:
    ```bash
    npm run test
    ```
*   **Style**: Follow standard TypeScript conventions. Use `camelCase` for variables and functions, and `PascalCase` for types and classes. Ensure strict type safety.

## Submitting a Pull Request

1.  **Test your changes**: verify that your code works as expected.
    *   For Python, manually verify the scripts.
    *   For TypeScript, ensure `npm run test` passes.
2.  **Commit your changes** with a clear and descriptive commit message.
3.  **Push to your fork**:
    ```bash
    git push origin feature/your-feature-name
    ```
4.  **Open a Pull Request**: Go to the original repository and open a PR. Provide a clear title and description of your changes, referencing any related issues.

## Code of Conduct

Please note that this project is released with a Contributor Code of Conduct. By participating in this project you agree to abide by its terms. We are committed to providing a welcoming and inspiring community for all.
