import vscode from "vscode";
import fs from "fs";
import path from "path";
import { run } from "npm-check-updates";
import { exec } from "child_process";

export function activate(context: vscode.ExtensionContext) {
    // Register in the command palette
    let disposable = vscode.commands.registerCommand(
        "update-npm-dependencies.updateDependencies",
        async () => {
            const rootPath = vscode.workspace.workspaceFolders
                ? vscode.workspace.workspaceFolders[0].uri.fsPath
                : undefined;

            if (!rootPath) {
                vscode.window.showErrorMessage("Please open a workspace with a package.json file.");
                return;
            }

            const packageJsonPath = path.join(rootPath, "package.json");

            if (!fs.existsSync(packageJsonPath)) {
                vscode.window.showErrorMessage(
                    "No package.json found in the root of the workspace."
                );
                return;
            }

            const checkingPackagesMessageItem = vscode.window.showInformationMessage(
                "Checking for new dependency versions..."
            );

            // Check for updates using npm-check-updates
            try {
                const updatedDependencies: any = await run({
                    packageFile: packageJsonPath,
                    jsonUpgraded: true,
                    upgrade: false,
                });

                if (Object.keys(updatedDependencies).length === 0) {
                    vscode.window.showInformationMessage("All dependencies are up to date.");
                    checkingPackagesMessageItem.then(() => {});
                    return;
                }

                // Create select options on which dependencies to update
                const pickItems: vscode.QuickPickItem[] = Object.keys(updatedDependencies).map(
                    (dep) => ({
                        label: dep,
                        description: `Current: ${updatedDependencies[dep]}`,
                    })
                );

                const selectedDeps = await vscode.window.showQuickPick(pickItems, {
                    canPickMany: true,
                    placeHolder: "Select the dependencies to update",
                });

                if (!selectedDeps || selectedDeps.length === 0) {
                    vscode.window.showInformationMessage("No dependencies selected for update.");
                    return;
                }

                // Prepare selected dependencies for update
                const selectedPackages = selectedDeps.map((dep) => dep.label).join(" ");

                // Run npm update for the selected dependencies
                const updatingPackagesMessageItem = vscode.window.showInformationMessage(
                    `Updating ${selectedPackages}...`
                );

                const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));

                // Update the package.json with the selected dependencies' new versions
                selectedDeps.forEach((dep) => {
                    if (packageJson.dependencies && packageJson.dependencies[dep.label]) {
                        packageJson.dependencies[dep.label] = updatedDependencies[dep.label];
                    } else if (
                        packageJson.devDependencies &&
                        packageJson.devDependencies[dep.label]
                    ) {
                        packageJson.devDependencies[dep.label] = updatedDependencies[dep.label];
                    }
                });

                fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2), "utf-8");

                // run the npm update <selected_packages> command in terminal
                exec(`npm update ${selectedPackages}`, { cwd: rootPath }, (err, stdout, stderr) => {
                    if (err) {
                        vscode.window.showErrorMessage("Error updating dependencies: " + stderr);
                    } else {
                        vscode.window.showInformationMessage(
                            "Selected dependencies updated successfully."
                        );
                    }
                });
            } catch (error: any) {
                vscode.window.showErrorMessage("Error checking for updates: " + error.message);
            }
        }
    );

    context.subscriptions.push(disposable);
}

export function deactivate() {}
