/**
 * frida/trinity_socket_hook.js
 * 
 * Host-Side Frida Dynamic Instrumentation for TRINITY RAG Socket Interception
 * Hooks native libuv / libc socket routines to:
 * 1. Intercept raw HTTP request & response frames targeting TRINITY :7700
 * 2. Measure kernel socket round-trip time below the Node.js fetch() layer
 * 3. Log exact request headers, payload byte lengths, and response chunks
 * 4. Diagnose kappa confidence scoring and tessa security gate variations
 * 
 * Usage:
 *   frida -p $(pgrep -f "tsx server.ts") -l frida/trinity_socket_hook.js
 */

'use strict';

console.log('[*] Loading Frida TRINITY :7700 Socket Interceptor...');

var TARGET_PORT = 7700;

// Resolve socket symbols across libc / libuv
var sendSym = Module.findExportByName(null, 'send');
var sendtoSym = Module.findExportByName(null, 'sendto');
var recvSym = Module.findExportByName(null, 'recv');
var writeSym = Module.findExportByName(null, 'write');
var connectSym = Module.findExportByName(null, 'connect');

var monitoredFds = new Set();
var pendingRequests = new Map(); // fd -> { startNs, path, bytesSent }

// Hook connect to detect connections to port 7700
if (connectSym) {
  Interceptor.attach(connectSym, {
    onEnter: function (args) {
      this.fd = args[0].toInt32();
      var addrPtr = args[1];
      if (!addrPtr.isNull()) {
        var family = addrPtr.readU16();
        // AF_INET is 2
        if (family === 2) {
          var portBigEndian = addrPtr.add(2).readU16();
          // Convert big-endian to host byte order
          var port = ((portBigEndian & 0xFF) << 8) | ((portBigEndian >> 8) & 0xFF);
          if (port === TARGET_PORT) {
            monitoredFds.add(this.fd);
            console.log('[+] [TRINITY Socket] Connected fd=' + this.fd + ' to port :' + TARGET_PORT);
          }
        }
      }
    }
  });
}

// Hook send/write to inspect outgoing HTTP requests to TRINITY
if (sendSym) {
  Interceptor.attach(sendSym, {
    onEnter: function (args) {
      var fd = args[0].toInt32();
      var buf = args[1];
      var len = args[2].toInt32();
      handleOutgoing(fd, buf, len, 'send');
    }
  });
}

if (writeSym) {
  Interceptor.attach(writeSym, {
    onEnter: function (args) {
      var fd = args[0].toInt32();
      var buf = args[1];
      var len = args[2].toInt32();
      handleOutgoing(fd, buf, len, 'write');
    }
  });
}

function handleOutgoing(fd, buf, len, syscall) {
  if (len <= 0 || buf.isNull()) return;
  try {
    var raw = buf.readUtf8String(Math.min(len, 1024));
    if (raw && (raw.indexOf('7700') !== -1 || raw.indexOf('/query') !== -1 || raw.indexOf('/context') !== -1 || raw.indexOf('/ingest') !== -1)) {
      monitoredFds.add(fd);
      var startNs = Process.hrtime ? Process.hrtime() : Date.now() * 1000000;
      var firstLine = raw.split('\r\n')[0] || raw.split('\n')[0];
      pendingRequests.set(fd, { startNs: startNs, firstLine: firstLine, bytes: len });
      console.log('\n[→ TRINITY ' + syscall + ' fd=' + fd + '] ' + firstLine + ' (' + len + ' bytes)');
      
      // Print JSON body preview if present
      var bodyIdx = raw.indexOf('\r\n\r\n');
      if (bodyIdx !== -1 && bodyIdx + 4 < raw.length) {
        var bodySnippet = raw.slice(bodyIdx + 4, Math.min(raw.length, bodyIdx + 250));
        console.log('    Payload: ' + bodySnippet.replace(/\n/g, ' '));
      }
    }
  } catch (e) {
    // Binary frame or non-UTF8 buffer
  }
}

// Hook recv to inspect incoming HTTP responses from TRINITY
if (recvSym) {
  Interceptor.attach(recvSym, {
    onEnter: function (args) {
      this.fd = args[0].toInt32();
      this.buf = args[1];
      this.len = args[2].toInt32();
    },
    onLeave: function (retval) {
      var bytesRead = retval.toInt32();
      if (bytesRead <= 0 || !monitoredFds.has(this.fd)) return;
      try {
        var raw = this.buf.readUtf8String(Math.min(bytesRead, 1024));
        var req = pendingRequests.get(this.fd);
        var elapsedMs = req && Process.hrtime ? (Process.hrtime() - req.startNs) / 1000000 : 0;
        
        var firstLine = raw ? (raw.split('\r\n')[0] || raw.split('\n')[0]) : 'HTTP Response';
        console.log('[← TRINITY recv fd=' + this.fd + '] ' + firstLine + ' (' + bytesRead + ' bytes, socket RTT: ' + elapsedMs.toFixed(2) + ' ms)');
        
        // Check for TRINITY confidence parameters in response
        if (raw && (raw.indexOf('kappa') !== -1 || raw.indexOf('tessa') !== -1 || raw.indexOf('documents') !== -1)) {
          var match = raw.match(/"kappa":\s*([0-9.]+)/);
          if (match) {
            console.log('    ✓ Parsed TRINITY Confidence kappa: ' + match[1]);
          }
        }
      } catch (e) {
        // Binary or chunked transfer
      }
    }
  });
}

console.log('[*] TRINITY socket interceptor active on port :' + TARGET_PORT + '.');
