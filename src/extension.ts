import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { run } from "npm-check-updates";
import { exec } from "child_process";

export function activate(context: vscode.ExtensionContext) {
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

            try {
                // Show progress for checking new dependencies using async/await
                const updatedDependencies = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: "Checking for new dependency versions...",
                        cancellable: false,
                    },
                    async (progress, token) => {
                        // Fetch updated dependencies using npm-check-updates
                        const updatedDependencies: any = await run({
                            packageFile: packageJsonPath,
                            jsonUpgraded: true, // Fetch latest versions
                            upgrade: false, // Don't upgrade just yet
                        });

                        progress.report({
                            increment: 100,
                            message: "Dependencies check complete.",
                        });
                        vscode.window.showInformationMessage(
                            `Found ${Object.keys(updatedDependencies).length} outdated packages`
                        );
                        return updatedDependencies;
                    }
                );

                if (Object.keys(updatedDependencies).length === 0) {
                    vscode.window.showInformationMessage("All dependencies are up to date.");
                    return;
                }

                // Create the checkboxes for updated dependencies
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

                const selectedPackages = selectedDeps.map((dep) => dep.label).join(" ");
                // Load the current package.json
                const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));

                // Update the selected dependencies in package.json
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

                // Write updated package.json
                fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2), "utf-8");

                // Progress for updating dependencies (async/await style)
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Updating ${selectedPackages}...`,
                        cancellable: false,
                    },
                    async (progress, token) => {
                        return new Promise<void>((resolve, reject) => {
                            // Run npm update command

                            exec(
                                `npm update ${selectedPackages}`,
                                { cwd: rootPath },
                                (err, stdout, stderr) => {
                                    if (err) {
                                        vscode.window.showErrorMessage(
                                            "Error updating dependencies: " + stderr
                                        );
                                        reject(err);
                                    } else {
                                        progress.report({
                                            increment: 100,
                                            message: "Selected dependencies updated successfully.",
                                        });
                                        vscode.window.showInformationMessage(
                                            "Selected dependencies updated successfully."
                                        );
                                        resolve();
                                    }
                                }
                            );
                        });
                    }
                );
            } catch (error: any) {
                vscode.window.showErrorMessage("Error: " + error.message);
            }
        }
    );

    context.subscriptions.push(disposable);
}

export function deactivate() {}
