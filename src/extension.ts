// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

import { AdbFS } from './adbfilesystemprovider';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('"adb-filesystem" become active.');

    try {
        const adbfs = new AdbFS();
        await adbfs.initializeDeviceTracking();

        context.subscriptions.push(
            vscode.workspace.registerFileSystemProvider('adbfs', adbfs, {
                isCaseSensitive: true
            })
        );
        context.subscriptions.push(
            vscode.commands.registerCommand('adbfs.workspaceInit', _ => {
                vscode.workspace.updateWorkspaceFolders(0, 0, {
                    uri: vscode.Uri.parse('adbfs:/'),
                    name: "Android Device Files"
                });
            })
        );
        // refresh file tree when the setting changed.
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('adbfs.sdcardFolderOnlyMode')) {
                    console.log("onDidChangeConfiguration called.");
                    vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer")
                }
            })
        );
        context.subscriptions.push({
            dispose: async () => {
                await adbfs.dispose();
            }
        });

    } catch (err) {
        console.error('Error activating extension:', err);
    }
}

// this method is called when your extension is deactivated
export function deactivate() {
    console.log('"adb-filesystem" deactivated.');
}
