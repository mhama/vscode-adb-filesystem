import * as vscode from 'vscode';
var adb = require('adbkit')
var adbClient = adb.createClient()
var concatStream = require('concat-stream');
var streamifier = require('streamifier');

export class AdbEntry implements vscode.FileStat {

    type: vscode.FileType;
    ctime: number;
    mtime: number;
    size: number;

    name: string;

    constructor(name: string, type: vscode.FileType) {
        this.type = type;
        this.ctime = Date.now();
        this.mtime = Date.now();
        this.size = 0;
        this.name = name;
    }
}

export class AdbFS implements vscode.FileSystemProvider {

    stat(uri: vscode.Uri): Thenable<vscode.FileStat> {
        let thenable = new Promise<vscode.FileStat>((resolve, reject) => {
            console.log("(promise) stat uri:" + uri);
            var adbpath = this.splitAdbPath(uri);
            console.log("deviceId:" + adbpath.deviceId + " path:" + adbpath.path);
            // check device parent dir
            if (adbpath.deviceId == "" || adbpath.deviceId == null) {
                let entry = new AdbEntry("(devices)", vscode.FileType.Directory);
                resolve(entry);
                return;
            }
            adbClient.stat(adbpath.deviceId, adbpath.path)
                .then((stats: any) => {
                    let entryType = stats.isFile() ? vscode.FileType.File : vscode.FileType.Directory;
                    let entry = new AdbEntry("", entryType);
                    if (stats.isFile()) {
                        entry.size = stats.size;
                    }
                    console.log("stat entry:", entry);
                    resolve(entry);
                })
                .catch((err: Error) => {
                    reject(err);
                });
        });
        return thenable;
    }

    readDevices(resolve: (value?: [string, vscode.FileType][] | PromiseLike<[string, vscode.FileType][]> | undefined) => void, reject : any) {
        console.log("adbfs readDevices called.");
        adbClient.listDevices()
            .then((devices: any) => {
                console.log("listDevices result received.", devices);
                let entries: [string, vscode.FileType][] = [];
                entries = devices.map((device: any) => {
                    return [device.id, vscode.FileType.Directory];
                });
                console.log("entries:", entries);
                resolve(entries);
            })
            .catch((err: Error) => {
                console.error('Something went wrong:', err.stack)
                reject(""+err);
            });
    }

    readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]> {
        let thenable = new Promise<[string, vscode.FileType][]>((resolve, reject) => {
            console.log("(promise) readDirectoryAdb uri:"+uri);
            if (uri.path == "/") {
                this.readDevices(resolve, reject);
                return;
            }
            var adbpath = this.splitAdbPath(uri);

            console.log("deviceId:"+adbpath.deviceId+" path:"+adbpath.path);
            adbClient.readdir(adbpath.deviceId, adbpath.path)
                .then((files: any) => {
                    console.log("readdir files:", files);
                    let entries: [string, vscode.FileType][] = [];
                    entries = files.map((file: any) => {
                        let entryType = file.isFile() ? vscode.FileType.File : vscode.FileType.Directory;
                        return [file.name, entryType];
                    });
                    console.log("readdir entries:", entries);
                    resolve(entries);
                })
                .catch((err: Error) => {
                    reject(err);
                });
          })
        return thenable;
    }

    readFile(uri: vscode.Uri): Thenable<Uint8Array> {
        let thenable = new Promise<Uint8Array>((resolve, reject) => {
            var adbpath = this.splitAdbPath(uri);
            adbClient.pull(adbpath.deviceId, adbpath.path)
            .then((transfer: any) => {
                var writable = concatStream({
                    encoding: 'uint8array'
                }, (data: any) => {
                    resolve(data);
                });
                transfer.on('error', reject)
                transfer.pipe(writable);
            })
            .catch((err: Error) => {
                reject(err);
            });
        });
        return thenable;
    }

    writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): Thenable<void> {
        let thenable = new Promise<void>((resolve, reject) => {
            let adbPath = this.splitAdbPath(uri);
            console.log("writeFile uri:" + uri+ " path:"+adbPath.path);
            let stream = streamifier.createReadStream(Buffer.from(content));
            adbClient.push(adbPath.deviceId, stream, adbPath.path)
                .then(() => {
                    console.log("writeFile succeeded.");
                    resolve();
                })
                .catch((err: Error) => {
                    reject(err)
                });
        });
        return thenable;
    }

    rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Thenable<void> {
        let thenable = new Promise<void>((resolve, reject) => {
            //adbClient.shell("mv "+path+" "+newPath).then...
            reject("rename not implemented yet.");
        });
        return thenable;
    }

    delete(uri: vscode.Uri): Thenable<void> {
        let thenable = new Promise<void>((resolve, reject) => {
            this.stat(uri).then((stats) => {
                if (stats.type == vscode.FileType.File) {
                    let adbPath = this.splitAdbPath(uri);
                    let cmd = "rm \""+adbPath.path+"\"";
                    console.log("delete file adb cmd: "+cmd);
                    adbClient.shell(adbPath.deviceId, cmd).then(() => {
                        resolve();
                    })
                    .catch((err: Error) => {
                        reject(err);
                    })
                } else {
                    reject("delete directory not implemented yet.");
                }
            })
        });
        return thenable;
    }

    createDirectory(uri: vscode.Uri): Thenable<void> {
        let thenable = new Promise<void>((resolve, reject) => {
            reject("create directory not implemented yet.");
        });
        return thenable;
    }

    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    // TODO: implement onDidChangeFile

    splitAdbPath(uri: vscode.Uri) {
        let parts = uri.path.split('/');
        if (parts[0] == '') {
            parts.shift();
        }
        let deviceId = parts[0];
        parts.shift();
        let path = parts.join("/");
        if (path == "") {
            path = "/sdcard";
        } else {
            path = "/sdcard/" + path;
        }
        return { "deviceId": deviceId, "path": path };
    }

    watch(_resource: vscode.Uri): vscode.Disposable {
        console.log("adbfs watch uri:"+_resource);
        return new vscode.Disposable(() => { });
    }
}
