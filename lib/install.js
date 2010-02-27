// npm install command

var npm = require("../npm"),
  utils = require("./utils"),
  rm = require("./utils/rm"),
  chain = require("./utils/chain"),
  log = utils.log,
  fail = utils.fail,
  succeed = utils.succeed,
  bind = utils.bind,
  fetch = require("./utils/fetch"),
  sys = require("sys"),
  fs = require("fs"),
  path = require("path");

module.exports = install;

// cb called with (er, ok) args.
function install (tarball, cb) {

  // fetch the tarball
  if (tarball.match(/^https?:\/\//)) {
    log("Fetch and then install: "+tarball);
    return fetchAndInstall(tarball, cb);
  }

  // install from a file.
  if (tarball.indexOf("file://") === 0) tarball = tarball.substr("file://".length);

  // don't do activation or dependencies yet.  just install in such a way
  // that these things are *possible* eventually.

  log("Install from: "+tarball);

  var ROOT = npm.root,
    npmdir = npm.dir,
    tmp = npm.tmp,
    unpackTargetDir = path.join(
      // todo: use a sha1 of the url, and don't fetch if it's there already
      tmp, path.basename(tarball, ".tgz")),
    unpackTargetTgz = path.join(
      unpackTargetDir, "package.tgz"),
    pkg = {};

  // at this point, presumably the filesystem knows how to open it.
  chain(
    [fs, "stat", tarball],
    [ensureDir, unpackTargetDir, 0755],
    [unpackTar, tarball, unpackTargetDir],
    // clean up
    [function (cb) { log("unpacked, deleting"); cb() }],
    [fs, "unlink", tarball],

    // read the json
    [function (cb) {
      readJson(path.join(unpackTargetDir, "package.json"), function (er, ok) {
        if (er) return cb(er, ok);
        // save this just for this install
        pkg.data = ok;
        cb(null, ok);
      });
    }],

    // move to ROOT/.npm/{name}/{version}/package
    [moveIntoPlace, unpackTargetDir, pkg],

    // generate ROOT/.npm/{name}/{version}/main.js
    [createMain, pkg],

    // symlink ROOT/{name}-{version}.js to ROOT/.npm/{name}/{version}/main.js
    [linkMain, pkg],

    // run the "make", if there is one.
    [runMake, pkg],

    // symlink ROOT/{name}-{version}/ to ROOT/.npm/{name}/{version}/{lib}
    [linkLib, pkg],

    // success!
    [function (cb) {
      log("Successfully installed "+pkg.data._npmKey);
      cb();
    }],

    cb
  );
};

// move to ROOT/.npm/{name}/{version}/package
function moveIntoPlace (dir, pkg, cb) {
  pkg = pkg.data;
  if (!pkg.name || !pkg.version) {
    return cb(new Error("Name or version not found in package info."));
  }
  var target = path.join(npm.dir, pkg.name, pkg.version);

  chain(
    [function (cb) {
      path.exists(target, function (e) {
        log(target + " " + (e?"exists, removing it":"doesn't exist, creating it"));
        if (e) rm(target, function (er, ok) {
          if (er) {
            log("couldn't remove "+target);
            cb(new Error(target+" exists, and can't be removed"));
          } else {
            log(target+" successfully unlinked");
            cb();
          };
        });
        else cb();
      });
    }],
    [ensureDir, target],
    [function (cb) { pkg._npmPackage = target = path.join(target, "package"); cb() }],
    [function (cb) { fs.rename(dir, target, cb) }],
    [function (cb) { log("moved into place"); cb() }],
    cb
  );
};

function fetchAndInstall (tarball, cb) {
  log("fetchAndInstall: "+tarball);
  ensureDir(npm.tmp, 0755, function (er, ok) {
    if (er) return cb(er, ok);
    var target = path.join(npm.tmp, tarball.replace(/[^a-zA-Z0-9]/g, "-")+"-"+
                           Date.now()+"-"+Math.random()+".tgz");

    fetch(tarball, target, function (er, ok) {
      if (er) return cb(er, ok);
      log("fetched, installing for reals now from "+target);
      install(target, cb);
    });
  });
};

function ensureDir (ensure, chmod, cb) {
  if (ensure.charAt(0) !== "/") ensure = path.join(process.cwd(), ensure);
  var dirs = ensure.split("/"),
    walker = [];
  if (arguments.length < 3) {
    cb = chmod;
    chmod = 0755;
  }
  log("Ensuring: "+ensure);
  walker.push(dirs.shift()); // gobble the "/" first
  (function S (d) {
    if (d === undefined) return cb();
    walker.push(d);
    var dir = walker.join("/");
    fs.stat(dir, function (er, s) {
      if (er) {
        fs.mkdir(dir, chmod, function (er, s) {
          if (er) return cb(new Error(
            "Failed to make "+dir+" while ensuring "+ensure));
          S(dirs.shift());
        });
      } else {
        if (s.isDirectory()) S(dirs.shift());
        else cb(new Error("Failed to mkdir "+dir+": File exists"));
      }
    });
  })(dirs.shift());
};

// not sure why this needs a timeout, but it's like it's trying
// to read the file in some cases before it's done writing, and then
// tar flips out.
function unpackTar (tarball, unpackTarget, cb) {
  setTimeout(function () {
    processCb("tar", ["xzvf", tarball, "--strip", "1", "-C", unpackTarget], cb);
  }, 100);
};

function readJson (jsonFile, cb) {
  fs.readFile(jsonFile, function (er, jsonString) {
    if (er) return cb(er, jsonString);
    var json;
    try {
      json = JSON.parse(jsonString);
    } catch (ex) {
      return cb(new Error(
        "Failed to parse json file: "+jsonFile+"\n"+ex.message+"\n"+jsonString));
    }
    json.name = json.name.replace(/([^\w-]|_)+/g, '-');
    // allow semvers, but also stuff like
    // 0.1.2-L24561-2010-02-25-13-41-32-903 for test/link packages.
    if (!(/([0-9]+\.){2}([0-9]+)(-[a-zA-Z0-9\.-]+)?/.exec(json.version))) {
      return cb(new Error("Invalid version: "+json.version));
    }
    var key = json.name+"-"+json.version;
    json._npmKey = key;
    npm.set(key, json);
    cb(null, json);
  });
};

function createMain (pkg,cb) {
  pkg = pkg.data;
  if (!pkg.main) return cb();

  var code =
      "// generated by npm, please don't touch!\n"+
      "module.exports=require("+
        JSON.stringify(path.join(npm.dir, pkg.name, pkg.version, "package", pkg.main)) +
      ");\n",
    proxyFile = path.join(npm.dir, pkg.name, pkg.version, "main.js");

  fs.writeFile(proxyFile, code, "ascii", cb);
};

// symlink ROOT/{name}-{version}/ to ROOT/.npm/{name}/{version}/{lib}
function linkLib (pkg, cb) {
  pkg = pkg.data;
  var lib = pkg.directories && pkg.directories.lib || pkg.lib || false;
    defLib = (lib === false);
  if (defLib) lib = "lib";

  var from = path.join(npm.dir, pkg.name, pkg.version, "package", lib),
    to = path.join(npm.root, pkg.name+"-"+pkg.version);

  function doLink (er) {
    if (er) return cb(er);
    processCb("ln", ["-s", from, to], cb);
  }

  fs.stat(from, function (er, s) {
    if (er) return (!defLib) ? cb(new Error("Libs dir not found "+from)) : cb();
    if (!s.isDirectory()) {
      if (!defLib) cb(new Error("Libs dir not a dir: "+lib));
      else cb();
    } else {
      // make sure that it doesn't already exist.  If so, rm it.
      fs.stat(to, function (er, s) {
        if (!er) fs.unlink(to, doLink);
        else doLink();
      })
    }
  });
};

function linkMain (pkg, cb) {
  pkg = pkg.data;
  if (!pkg.main) return;
  var
    from = path.join(npm.dir, pkg.name, pkg.version, "main.js"),
    to = path.join(npm.root, pkg.name+"-"+pkg.version+".js");
  path.exists(to, function (e) {
    if (e) cb();
    else processCb("ln", ["-s", from, to], cb);
  });
};

function runMake (pkg, cb) {
  pkg = pkg.data;
  if (!pkg.make) return cb();
  log("runMake: "+pkg.make+" (wd: "+pkg._npmPackage+")");
  process.chdir(pkg._npmPackage);
  sys.exec(pkg.make, function (er, ok, stderr) {
    if (er) cb(er, ok, stderr);
    else cb(null, ok, stderr);
  });
};

function processCb (cmd, args, cb) {
  log(cmd+" "+args.map(JSON.stringify).join(" "));
  process.createChildProcess(cmd, args)
    .addListener("error", function (chunk) {
      if (chunk) process.stdio.writeError(chunk)
    })
    .addListener("output", function (chunk) {
      if (chunk) process.stdio.write(chunk)
    })
    .addListener("exit", function (code) {
      if (code) cb(new Error("`"+cmd+"` failed with "+code));
      else cb(null, code);
    });
};
