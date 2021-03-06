// Extension commands
const commands = require('commands.js');

// gopls utilities
const gopls = require('gopls.js');
const lsp = require('lsp.js');

// Append an extension config/command name to the extension prefix
function exItem(name) {
    return [nova.extension.identifier, name].join('.');
}

function plog(prefix) {
    return (msg) => {
        console.info(`${prefix}: ${msg}`);
    };
}

function createTasks() {
    let go = gopls.ToolPath('go');
    if (!go) {
        console.warn("Couldn't find go executable");
        return;
    }

    let tasks = [];
    let modTidy = new Task('Mod Tidy');
    modTidy.setAction(
        Task.Build,
        new TaskProcessAction(go, {
            args: ['mod', 'tidy'],
            env: {},
        })
    );
    tasks.push(modTidy);

    let modVendor = new Task('Mod Vendor');
    modVendor.setAction(
        Task.Build,
        new TaskProcessAction(go, {
            args: ['mod', 'vendor'],
            env: {},
        })
    );
    tasks.push(modVendor);

    nova.assistants.registerTaskAssistant({
        provideTasks: function () {
            return [modTidy, modVendor];
        },
    });
}

// Language server instance
var gls = null;

exports.activate = () => {
    createTasks();
    gls = new GoLanguageServer();
    gls.start().then(plog('activate')).catch(plog('activate warning'));
};

exports.deactivate = () => {
    if (gls !== null) {
        gls.dispose();
        gls = null;
    }
};

class GoLanguageServer {
    constructor() {
        nova.commands.register(
            exItem('cmd.installGopls'),
            (workspace) => commands.InstallGopls(workspace, this),
            this
        );
        nova.commands.register(exItem('cmd.restartGopls'), this.restart, this);

        // Observe the configuration setting for the server's location, and restart the server on change
        nova.config.onDidChange(exItem('gopls-path'), (current, previous) => {
            // If the user deletes the value in the preferences and presses
            // return or tab, it will revert to the default of 'gopls'.
            // But on the way there, we get called once with with current === null
            // and again with current === previous, both of which we need to ignore.
            if (current && current != previous) {
                this.restart()
                    .then(plog('gopls path change'))
                    .catch(plog('gopls restart failed after path change'));
            }
        });

        nova.config.onDidChange(exItem('gopls-trace'), (current) => {
            this.restart()
                .then(plog(`gopls-trace set to ${current}`))
                .catch(plog(`gopls-trace restart fail`));
        });
    }

    dispose() {
        this.stop().then(plog('dispose')).catch('dispose fail');
    }

    start() {
        return new Promise((resolve, reject) => {
            if (this.languageClient) {
                return resolve('gopls is already running');
            }
            if (!nova.workspace.path) {
                return reject('The Nova workspace has no path!');
            }

            // Create the client
            var serverOptions = {
                path: gopls.ToolPath(
                    nova.config.get(exItem('gopls-path'), 'string')
                ),
                args: ['serve'],
            };

            if (serverOptions.path === undefined) {
                nova.workspace.showWarningMessage(
                    `Cannot locate gopls.\n\nMake sure it installed in $GOPATH/bin, somewhere in $PATH, or provide the full path in the ${nova.extension.name} extension config.`
                );
                return reject('cannot locate gopls');
            }
            if (nova.config.get(exItem('gopls-trace'), 'boolean')) {
                console.log('gopls rpc tracing is enabled');
                serverOptions.args = serverOptions.args.concat(['-rpc.trace']);
            }
            console.log('server options:', JSON.stringify(serverOptions));

            var clientOptions = {
                // The set of document syntaxes for which the server is valid
                syntaxes: ['go'],
                initializationOptions: gopls.Settings(),
            };
            console.log('client options:', JSON.stringify(clientOptions));

            var client = new LanguageClient(
                'gopls',
                'gopls',
                serverOptions,
                clientOptions
            );

            try {
                client.start();
                nova.subscriptions.add(client);
                this.languageClient = client;
            } catch (err) {
                return reject(err);
            }

            // Look for the language server to be running.
            var tries = 10;
            var i = setInterval(() => {
                if (
                    this &&
                    this.languageClient &&
                    this.languageClient.running
                ) {
                    clearInterval(i);
                    this.registerCommands();
                    this.registerHooks();
                    resolve('gopls is running');
                }
                if (tries < 1) {
                    reject('gopls failed to start');
                }
                tries = tries - 1;
            }, 50);
        });
    }

    stop() {
        return new Promise((resolve) => {
            if (this.languageClient) {
                this.languageClient.onDidStop((err) => {
                    if (err) {
                        // As of Nova 2.0, gopls does not cleanly shut down
                        // because Nova sends an empty parameters object to
                        // the lsp shutdown command rather than null, as per
                        // the lsp spec.
                        console.log(`ignoring gopls exit: ${err}`);
                    }
                    resolve('gopls stopped');
                });
                this.languageClient.stop();
                nova.subscriptions.remove(this.languageClient);
                this.languageClient = null;
            } else {
                resolve('gopls is not running');
            }
        });
    }

    restart() {
        return this.stop()
            .then(() => {
                return this.start();
            })
            .then(plog('restart'))
            .catch(plog('restart fail'));
    }

    // Register extension commands that depend on the language client
    registerCommands() {
        if (!this.lcCommandsRegistered) {
            nova.commands.register(
                exItem('cmd.organizeImports'),
                (editor) =>
                    commands.OrganizeImports(editor, this.languageClient),
                this
            );
            nova.commands.register(
                exItem('cmd.formatFile'),
                (editor) => commands.FormatFile(editor, this.languageClient),
                this
            );
            nova.commands.register(
                exItem('cmd.findReferences'),
                (editor) =>
                    commands.FindReferences(editor, this.languageClient),
                this
            );
            nova.commands.register(
                exItem('cmd.findImplementations'),
                (editor) =>
                    commands.FindImplementations(editor, this.languageClient),
                this
            );
            nova.commands.register(
                exItem('cmd.findDefinition'),
                (editor) =>
                    commands.FindDefinition(editor, this.languageClient),
                this
            );
            nova.commands.register(
                exItem('cmd.findTypeDefinition'),
                (editor) =>
                    commands.FindTypeDefinition(editor, this.languageClient),
                this
            );
            nova.commands.register(
                exItem('cmd.jumpBack'),
                (editor) => commands.JumpBack(editor, this.languageClient),
                this
            );
            this.lcCommandsRegistered = true;
            console.log('Registered language client commands');
        } else {
            console.log('Language client commands are already registered');
        }
    }

    registerHooks() {
        if (!this.lcHooksRegistered) {
            nova.workspace.onDidAddTextEditor((editor) => {
                editor.onDidSave(() => {
                    console.log('Saved complete');
                });
                editor.onWillSave((editor) => {
                    if (editor.document.syntax === 'go') {
                        if (nova.config.get(exItem('fmtsave'))) {
                            console.info('fmtsave entry');
                            return commands
                                .FormatFile(editor, this.languageClient)
                                .then(() => {
                                    console.info('fmtsave done');
                                });
                        }
                    }
                }, this);
            }, this);
            this.lcHooksRegistered = true;
            console.log('Registered language client hooks');
        } else {
            console.log('Hooks already registered');
        }
    }
}
