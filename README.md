# Update NPM Dependencies

![Extension Icon](path-to-your-icon.png) <!-- Replace with your icon file path -->

## Overview

**Update NPM Dependencies** is a Visual Studio Code extension designed to streamline the process of managing and updating dependencies in Node.js projects. It allows developers to easily check for outdated packages, select which to update, and automatically apply the changes—all from within VS Code.

## Features

-   **Check for Updates**: Scans your `package.json` file to identify dependencies with newer versions available on npm.
-   **Interactive Update Selection**: Displays a checkbox list of outdated dependencies, allowing you to select which to update.
-   **Automatic Updates**:
    -   Updates the selected dependencies' versions in `package.json`.
    -   Executes `npm update` to install the new versions.
-   **Progress Notifications**:
    -   Real-time progress indicators for tasks such as checking dependencies and updating packages.

## How It Works

1. Open a Node.js project in Visual Studio Code with a valid `package.json` file.
2. Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux) to open the Command Palette.
3. Search for and select **Update NPM Dependencies**.
4. The extension will:
    - Check for outdated dependencies.
    - Show a checkbox list of dependencies with available updates.
5. Select the dependencies to update and click **Update**.
6. The extension will update the `package.json` file and synchronize the changes by running `npm update`.

## Installation

1. Open the Extensions view in VS Code (`Ctrl+Shift+X` or `Cmd+Shift+X`).
2. Search for **Update NPM Dependencies**.
3. Click **Install**.

Alternatively, you can install it from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/).

## Commands

-   **Update NPM Dependencies** (`update-npm-dependencies.updateDependencies`): Checks for updates and allows you to select and update outdated dependencies.

## Requirements

-   A Node.js project with a `package.json` file.
-   `npm` must be installed and accessible in your system's PATH.

## Feedback and Contributions

We welcome your feedback and contributions! If you encounter issues or have ideas for new features, please open an issue or submit a pull request on our [GitHub repository](https://github.com/your-repo-url).

## License

This extension is licensed under the [MIT License](LICENSE).
