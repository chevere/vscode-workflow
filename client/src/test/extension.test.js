const assert = require('assert');
const vscode = require('vscode');

suite('Extension', () => {
    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension('chevere.vscode-workflow');
        await ext.activate();
    });

    test('activates without error', () => {
        const ext = vscode.extensions.getExtension('chevere.vscode-workflow');
        assert.ok(ext.isActive);
    });

    test('registers showJobGraph command', async () => {
        const cmds = await vscode.commands.getCommands(true);
        assert.ok(cmds.includes('chevereWorkflow.showJobGraph'));
    });

    test('registers restartServer command', async () => {
        const cmds = await vscode.commands.getCommands(true);
        assert.ok(cmds.includes('chevereWorkflow.restartServer'));
    });

    test('registers installWorkflow command', async () => {
        const cmds = await vscode.commands.getCommands(true);
        assert.ok(cmds.includes('chevereWorkflow.installWorkflow'));
    });
});
