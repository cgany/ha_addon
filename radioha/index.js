const port = 3005; // 포트 설정
const mytoken = 'homeassistant' // 토큰 설정
const http = require('http');
const url = require("url");
const child_process = require("child_process");
const fs = require('fs');
const axios = require('axios');
const { Transform } = require('stream');
const data = JSON.parse(fs.readFileSync('/app/radio-list.json', 'utf8')); // 라디오 주소 저장 파일 열기

const instance = axios.create({
    timeout: 3000,
});


// ============================================================
// HLS + Sonos artwork support
// KBS Classic 전용 테스트
// ============================================================

const os = require('os');
const path = require('path');

const HLS_DIR = path.join(os.tmpdir(), 'radioha_hls');
const HLS_SEGMENT_TIME = 6;
const HLS_PLAYLIST_SIZE = 5;

const SONOS_ARTWORK_URL =
    'http://192.168.0.32:8123/local/images/logos/kclassic.png';

if (!fs.existsSync(HLS_DIR)) {
    fs.mkdirSync(HLS_DIR, { recursive: true });
}

let hlsProcess = null;
let hlsSequence = 0;
let hlsStarted = false;

let hlsSegmentWatcher = null;
const hlsTaggedSegments = new Set();

// ID3v2 sync-safe integer
function id3SyncSafe(size) {
    return Buffer.from([
        (size >> 21) & 0x7f,
        (size >> 14) & 0x7f,
        (size >> 7) & 0x7f,
        size & 0x7f
    ]);
}


// ID3v2.3 frame
function id3Frame(id, body) {
    const header = Buffer.alloc(10);

    header.write(id, 0, 4, 'ascii');
    header.writeUInt32BE(body.length, 4);
    header.writeUInt16BE(0, 8);

    return Buffer.concat([header, body]);
}


// ID3v2.3 WXXX
function makeWxxxFrame() {
    const description = Buffer.from('artworkURL_640x', 'latin1');
    const imageUrl = Buffer.from(SONOS_ARTWORK_URL, 'latin1');

    const body = Buffer.concat([
        Buffer.from([0x00]),
        description,
        Buffer.from([0x00]),
        imageUrl
    ]);

    return id3Frame('WXXX', body);
}


// HLS packed-audio timestamp PRIV frame
function makeTimestampPrivFrame(timestamp90k) {
    const owner = Buffer.from(
        'com.apple.streaming.transportStreamTimestamp',
        'latin1'
    );

    const timestamp = Buffer.alloc(8);

    timestamp.writeBigUInt64BE(
        BigInt(timestamp90k),
        0
    );

    const body = Buffer.concat([
        owner,
        Buffer.from([0x00]),
        timestamp
    ]);

    return id3Frame('PRIV', body);
}


// ID3v2.3 tag
function makeSonosId3(sequence) {
    const timestamp90k =
        sequence * HLS_SEGMENT_TIME * 90000;

    const frames = Buffer.concat([
        makeTimestampPrivFrame(timestamp90k),
        makeWxxxFrame()
    ]);

    const header = Buffer.concat([
        Buffer.from('ID3', 'ascii'),
        Buffer.from([0x03, 0x00, 0x00]),
        id3SyncSafe(frames.length)
    ]);

    return Buffer.concat([
        header,
        frames
    ]);
}


// ============================================================
// AAC 세그먼트 앞에 Sonos용 ID3 태그 삽입
// ============================================================
function addSonosId3ToSegment(filepath, sequence) {

    try {

        if(!fs.existsSync(filepath)){
            return;
        }

        const audio = fs.readFileSync(filepath);

        const id3 = makeSonosId3(sequence);

        fs.writeFileSync(
            filepath,
            Buffer.concat([
                id3,
                audio
            ])
        );

        console.log(
            'Sonos ID3 artwork added:',
            path.basename(filepath)
        );

    } catch(e) {

        console.log(
            'Sonos ID3 error:',
            e
        );

    }
}

function startKbsClassicHls() {

    // 이미 실행 중이면 다시 시작하지 않음
    if (hlsProcess) {
        return;
    }

    // 이전 HLS 파일 정리
    try {
        const files = fs.readdirSync(HLS_DIR);

        for (const file of files) {
            fs.unlinkSync(path.join(HLS_DIR, file));
        }
    } catch (e) {
        console.log('HLS cleanup error:', e);
    }

    // KBS Classic 원본 스트림 주소 가져오기
    getkbs('kbs_classic').then(function(urls) {

        if (urls == 'invaild' || !urls.includes('m3u8')) {

            console.log(
                'KBS Classic HLS URL acquisition failed'
            );

            return;
        }

        console.log(
            'KBS Classic HLS source:',
            urls
        );

const HLS_SOURCE_DIR =
    path.join(os.tmpdir(), 'radioha_hls_source');

if (!fs.existsSync(HLS_SOURCE_DIR)) {
    fs.mkdirSync(HLS_SOURCE_DIR, { recursive: true });
}

const segmentPattern =
    path.join(
        HLS_SOURCE_DIR,
        'segment_%05d.aac'
    );

// ============================================================
// 완성된 AAC 세그먼트 감시 및 Sonos ID3 추가
// ============================================================

if (!hlsSegmentWatcher) {

    hlsSegmentWatcher = setInterval(function() {

        let files;

        try {
            files = fs.readdirSync(HLS_SOURCE_DIR);
        } catch(e) {
            return;
        }

        files
            .filter(function(file) {
                return /^segment_\d+\.aac$/.test(file);
            })
            .forEach(function(file) {

                const match =
                    file.match(/^segment_(\d+)\.aac$/);

                if(!match) {
                    return;
                }

                const sequence =
                    parseInt(match[1], 10);

                if(hlsTaggedSegments.has(sequence)) {
                    return;
                }

                const sourcePath =
                    path.join(HLS_SOURCE_DIR, file);

                const targetPath =
                    path.join(HLS_DIR, file);

                if(!fs.existsSync(sourcePath)) {
                    return;
                }

                let size1;

                try {
                    size1 = fs.statSync(sourcePath).size;
                } catch(e) {
                    return;
                }

                setTimeout(function() {

                    if(!fs.existsSync(sourcePath)) {
                        return;
                    }

                    let size2;

                    try {
                        size2 = fs.statSync(sourcePath).size;
                    } catch(e) {
                        return;
                    }

                    if(size1 !== size2) {
                        return;
                    }

                    try {

                        const audio =
                            fs.readFileSync(sourcePath);

                        const id3 =
                            makeSonosId3(sequence);

                        fs.writeFileSync(
                            targetPath,
                            Buffer.concat([
                                id3,
                                audio
                            ])
                        );

                        hlsTaggedSegments.add(sequence);

                        console.log(
                            'Sonos ID3 artwork added:',
                            file
                        );

                    } catch(e) {

                        console.log(
                            'Sonos ID3 segment error:',
                            e
                        );

                    }

                }, 1000);

            });

    }, 1000);
}
		
        // FFmpeg로 KBS Classic을 AAC로 변환하면서
        // 6초 단위의 HLS용 세그먼트를 생성
        hlsProcess = child_process.spawn("ffmpeg", [

            "-loglevel", "error",

            "-i", urls,

            "-vn",

            "-c:a", "aac",
            "-b:a", "128k",
            "-ar", "44100",
            "-ac", "2",

            "-f", "segment",
            "-segment_time", String(HLS_SEGMENT_TIME),
            "-segment_format", "adts",
            "-reset_timestamps", "1",

            segmentPattern

        ], {
            detached: false
        });

        hlsStarted = true;

        console.log(
            "KBS Classic HLS ffmpeg started:",
            hlsProcess.pid
        );

        // FFmpeg 오류 출력
        hlsProcess.stderr.on("data", function(data) {

            console.log(
                "HLS ffmpeg:",
                data.toString().trim()
            );

        });

        // FFmpeg 종료 처리
        hlsProcess.on("exit", function(code) {

            console.log(
                "KBS Classic HLS ffmpeg exited:",
                code
            );

            hlsProcess = null;
            hlsStarted = false;

        });

        // FFmpeg 실행 오류
        hlsProcess.on("error", function(e) {

            console.log(
                "KBS Classic HLS ffmpeg error:",
                e
            );

            hlsProcess = null;
            hlsStarted = false;

        });

    });
}


// ============================================================
// ICY MP3 Radio wrapper
// 기존 /radio 스트림에 ICY StreamTitle 삽입
// ============================================================

const ICY_METAINT = 16000;

function makeIcyMetadata(title) {

    const metadata =
        Buffer.from(
            "StreamTitle='" + title + "';",
            'utf8'
        );

    const paddedLength =
        Math.ceil(metadata.length / 16) * 16;

    const block =
        Buffer.alloc(1 + paddedLength);

    block[0] =
        paddedLength / 16;

    metadata.copy(
        block,
        1
    );

    return block;
}


class IcyMetadataTransform extends Transform {

    constructor(title) {

        super();

        this.title = title;
        this.audioBytes = 0;

    }

    _transform(chunk, encoding, callback) {

        let offset = 0;

        while(offset < chunk.length) {

            const remaining =
                ICY_METAINT - this.audioBytes;

            const length =
                Math.min(
                    remaining,
                    chunk.length - offset
                );

            this.push(
                chunk.subarray(
                    offset,
                    offset + length
                )
            );

            offset += length;
            this.audioBytes += length;

            if(this.audioBytes >= ICY_METAINT) {

                this.push(
                    makeIcyMetadata(
                        this.title
                    )
                );

                this.audioBytes = 0;
            }
        }

        callback();
    }
}


function startIcyRadio(key, resp, req) {

    const upstreamUrl =
        'http://127.0.0.1:' +
        port +
        '/radio?keys=' +
        encodeURIComponent(key) +
        '&token=' +
        encodeURIComponent(mytoken);

    console.log(
        'ICY upstream:',
        upstreamUrl
    );

    const upstream =
        http.get(
            upstreamUrl,
            {
                headers: {
                    'icy-metadata': '1'
                }
            },
            function(upstreamResp) {

                if(upstreamResp.statusCode != 200) {

                    console.log(
                        'ICY upstream status:',
                        upstreamResp.statusCode
                    );

                    resp.statusCode =
                        upstreamResp.statusCode;

                    resp.end();

                    return;
                }

                resp.writeHead(
                    200,
                    {
                        'Content-Type':
                            'audio/mpeg',

                        'Cache-Control':
                            'no-cache',

                        'icy-metaint':
                            String(ICY_METAINT),

                        'icy-name':
                            'KBS Classic',

                        'icy-genre':
                            'Classical',

                        'icy-br':
                            '128'
                    }
                );

                const icyStream =
                    new IcyMetadataTransform(
                        'KBS Classic'
                    );

                upstreamResp.pipe(
                    icyStream
                ).pipe(
                    resp
                );

                req.on(
                    'close',
                    function() {

                        upstream.destroy();
                        icyStream.destroy();

                    }
                );

            }
        );

    upstream.on(
        'error',
        function(e) {

            console.log(
                'ICY upstream error:',
                e
            );

            if(!resp.headersSent) {
                resp.statusCode = 500;
            }

            resp.end();

        }
    );
}



function return_pipe(urls, resp, req) {
    var xffmpeg = child_process.spawn("ffmpeg", [
         "-loglevel", "error", "-i", urls, "-metadata", "title=Korea Radio for HA", "-acodec", "libmp3lame", "-ar", "44100", "-f", "mp3", "pipe:1" // output to stdout
    ], {
        detached: false
    });

    xffmpeg.stdout.pipe(resp);
    console.log("new input " + xffmpeg.pid);

    xffmpeg.on("exit", function(code) {});

    xffmpeg.on("error", function(e) {
        console.log("Xsystem error: " + e);
    });
	
    xffmpeg.stdout.on("data",function(data) {
    });

    req.on("close", function() {
        if (xffmpeg) {
            console.log("close " + xffmpeg.pid);
            xffmpeg.kill();
        }
    });

    req.on("end", function() {
        if (xffmpeg) {
            console.log("end " + xffmpeg.pid);
            xffmpeg.kill();
        }
    });
}

var liveServer = http.createServer((req, resp) => {
    const urlParts = url.parse(req.url, true);
    const urlParams = urlParts.query;
	console.log(urlParams);
	const urlPath = urlParts.pathname;

    // ========================================================
    // KBS Classic HLS 테스트
    // ========================================================
    if(urlPath == "/radio_hls" || urlPath.startsWith("/radio_hls/")){

        const token_key = urlParams['token'];
        const key = urlParams['keys'];

        // 토큰 확인
        if(token_key != mytoken){
            resp.writeHead(403, {
                'Content-Type': 'text/plain'
            });

            resp.end('Forbidden');
            return;
        }

        // 현재는 KBS Classic만 허용
        if(key != 'kbs_classic'){
            resp.writeHead(404, {
                'Content-Type': 'text/plain'
            });

            resp.end('Not Found');
            return;
        }

        // HLS FFmpeg 시작
        startKbsClassicHls();

        // --------------------------------------------
        // AAC 세그먼트 요청
        // --------------------------------------------
        const segmentMatch =
            urlPath.match(/^\/radio_hls\/segment\/(segment_\d+\.aac)$/);

        if(segmentMatch){

            const filename = segmentMatch[1];
            const filepath = path.join(HLS_DIR, filename);

            if(fs.existsSync(filepath)){

                resp.writeHead(200, {
                    'Content-Type': 'audio/aac',
                    'Cache-Control': 'no-cache'
                });

                const stream =
                    fs.createReadStream(filepath);

                stream.pipe(resp);

                stream.on('error', function(err){

                    console.log(
                        'HLS segment read error:',
                        err
                    );

                    if(!resp.headersSent){
                        resp.writeHead(500);
                    }

                    resp.end();
                });

            } else {

                resp.writeHead(404, {
                    'Content-Type': 'text/plain'
                });

                resp.end('Segment not found');
            }

            return;
        }

        // --------------------------------------------
        // HLS playlist 생성
        // --------------------------------------------
        const playlistFiles = fs.readdirSync(HLS_DIR)
            .filter(function(file) {
                return /^segment_\d+\.aac$/.test(file);
            })
            .sort();

        if(playlistFiles.length == 0){

            resp.writeHead(503, {
                'Content-Type': 'text/plain',
                'Cache-Control': 'no-cache'
            });

            resp.end('HLS stream is starting');
            return;
        }

        // 최근 세그먼트만 사용
        const recentFiles =
            playlistFiles.slice(-HLS_PLAYLIST_SIZE);

        const firstSequence =
            parseInt(
                recentFiles[0]
                    .match(/segment_(\d+)\.aac/)[1]
            );

        let playlist =
            '#EXTM3U\n' +
            '#EXT-X-VERSION:3\n' +
            '#EXT-X-TARGETDURATION:' +
            HLS_SEGMENT_TIME +
            '\n' +
            '#EXT-X-MEDIA-SEQUENCE:' +
            firstSequence +
            '\n';

        for(const file of recentFiles){

            playlist +=
                '#EXTINF:' +
                HLS_SEGMENT_TIME +
                '.000,\n';

            playlist +=
                'segment/' +
                file +
                '?token=' +
                encodeURIComponent(mytoken) +
                '&keys=kbs_classic\n';
        }

        resp.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-cache, no-store'
        });

        resp.end(playlist);

        return;
		
		
    }
    // ========================================================
    // KBS Classic ICY MP3 테스트
    // ========================================================

    if(urlPath == "/radio_icy") {

        const token_key = urlParams['token'];
        const key = urlParams['keys'];

        if(token_key != mytoken) {

            resp.writeHead(403, {
                'Content-Type': 'text/plain'
            });

            resp.end('Forbidden');

            return;
        }

        if(key != 'kbs_classic') {

            resp.writeHead(404, {
                'Content-Type': 'text/plain'
            });

            resp.end('Not Found');

            return;
        }

        startIcyRadio(
            key,
            resp,
            req
        );

        return;
    }

    if(urlPath == "/radio"){	

	    const token_key = urlParams['token'];
	    if(token_key == mytoken){
		    const key = urlParams['keys'];
		    console.log("your input : " + key);

		    if (key) {
			    const myData = data[key];
			    if (Object.hasOwnProperty.call(data, key)) { // 라디오 리스트에 key가 존재한다면?
				    if (!myData.includes('http')) {

					    if (myData == "kbs_lib") {
						    getkbs(key).then(function(data1) {


							    var urls = data1;
							    if (urls != 'invaild' && urls.includes('m3u8')) {

								    return_pipe(urls, resp, req);
							    } else {
							    	resp.statusCode = 403;
							    	resp.setHeader('Content-Type', 'text/plain; charset=utf-8');
							    	resp.end('호출 실패');
							    }
						    });
					    }
						
					    if (myData == "sbs_lib") {
						    getsbs(key).then(function(data1) {

							    var urls = data1;
							    if (urls != 'invaild' && urls.includes('m3u8')) {
								    return_pipe(urls, resp, req);
							    } else {
							    	resp.statusCode = 403;
							    	resp.setHeader('Content-Type', 'text/plain; charset=utf-8');
							    	resp.end('호출 실패');
							    }
						    });
					    }
						
					    if (myData == "mbc_lib") {
					    	getmbc(key).then(function(data1) {
					    
					    		var urls = data1;
					    		if (urls != 'invaild' && urls.includes('m3u8')) {
					    			return_pipe(urls, resp, req);
					    		} else {
					    			resp.statusCode = 403;
					    			resp.setHeader('Content-Type', 'text/plain; charset=utf-8');
					    			resp.end('호출 실패');
					    		}
					    	});
					    }
				    } else {
				    	var beforeEn = true;
				    	var urls = myData
				    	return_pipe(urls, resp, req);
				    }
			    } else {
			    
			    	resp.statusCode = 403;
			    	resp.setHeader('Content-Type', 'text/plain; charset=utf-8');
			    	resp.end('올바르지 않은 코드');
			    }
		    } else {
		    
		    	resp.statusCode = 403;
		    	resp.setHeader('Content-Type', 'text/plain; charset=utf-8');
		    	resp.end('올바르지 않은 접근');
		    }
		} else {
			resp.statusCode = 403;
			resp.setHeader('Content-Type', 'text/plain; charset=utf-8');
			resp.end('올바르지 않은 접근');
		}
	} else {
        resp.statusCode = 403;
        resp.setHeader('Content-Type', 'text/plain; charset=utf-8');
        resp.end('올바르지 않은 접근');
	}
});

function getkbs(param) {
    return new Promise(function(resolve, reject) {

        let kbs_ch = {
            'kbs_1radio': '21',
            'kbs_3radio': '23',
            'kbs_classic': '24',
            'kbs_cool': '25',
            'kbs_happy': '22'
        };
        try {
            instance({
                    method: 'get', //you can set what request you want to be
                    url: 'https://onair.kbs.co.kr/index.html?sname=onair&stype=live&ch_code=' + kbs_ch[param],
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36'
                    }
                })

                .then(response => {

                    var lines = response.data.split('\n');
                    var x = 0;
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].includes("Key-Pair-Id")) {
                            var mLine = lines[i];

                            break;
                        } else {
                            x += 1;
                        }
                    }

                    if (mLine) {
                        mLine = mLine.replace(/\\"/g, '"');

                        var mStream = mLine.split('"service_url":"')[1].split('"')[0];
                        resolve(mStream);
                    }


                }).catch(e => {
                    console.log(e)
                    resolve("invaild");
                })
        } catch (err) {
            resolve("invaild");
        }
    });
}

function getmbc(ch) {
    return new Promise(function(resolve, reject) {
        try {
            let mbc_ch = {
                'mbc_fm4u': 'mfm',
                'mbc_fm': 'sfm',
                'allthat': 'chm'
            };

            instance({
                    method: 'get',
                    url: 'http://miniplay.imbc.com/WebHLS.ashx?channel=' + mbc_ch[ch] + '&protocol=M3U8&agent=ios&nocash=0.3996827673840577&callback=jarvis.miniInfo.loadOnAirComplete',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36',
                        'Referer': 'http://mini.imbc.com/',
                        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
                        'Accept-Encoding': 'gzip, deflate'
                    }
                })

                .then(response => {
                    var text = 'http://' + response.data.split('"http://')[1].split('"')[0];

                    instance({
                            method: 'get',
                            url: text,
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36',
                                'Referer': 'http://mini.imbc.com/',
                                'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
                                'Accept-Encoding': 'gzip, deflate'
                            }
                        })

                        .then(response2 => {

                            var text2 = response2.data.split('m3u8?')[1].trim();
                            resolve('http://175.158.10.83/s' + mbc_ch[ch] + '/_definst_/' + mbc_ch[ch] + '.stream/playlist.m3u8?' + text2);

                        }).catch(e => {
                            console.log(e);
                            resolve("invaild");
                        })
                }).catch(e => {
                    console.log(e);
                    resolve("invaild");
                })
        } catch (err) {
            resolve("invaild");
        }
    });
}

function getsbs(ch) {
    return new Promise(function(resolve, reject) {

        let sbs_ch = {
            'sbs_power': ['powerfm', 'powerpc'],
            'sbs_love': ['lovefm', 'lovepc']
        }
        try {
            instance({
                    method: 'get',
                    url: 'https://apis.sbs.co.kr/play-api/1.0/livestream/' + sbs_ch[ch][1] + '/' + sbs_ch[ch][0] + '?protocol=hls&ssl=Y',
                    headers: {
                        'Host': 'apis.sbs.co.kr',
                        'Connection': 'keep-alive',
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_16_0) AppleWebKit/537.36 (KHTML, like Gecko) GOREALRA/1.2.1 Chrome/85.0.4183.121 Electron/10.1.3 Safari/537.36',
                        'Accept': '*/*',
                        'Origin': 'https://gorealraplayer.radio.sbs.co.kr',
                        'Sec-Fetch-Site': 'same-site',
                        'Sec-Fetch-Mode': 'cors',
                        'Sec-Fetch-Dest': 'empty',
                        'Referer': 'https://gorealraplayer.radio.sbs.co.kr/main.html?v=1.2.1',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Accept-Language': 'ko',
                        'If-None-Match': 'W/"134-0OoLHiGF4IrBKYLjJQzxNs0/11M"'
                    }
                })
                .then(response => {

                    resolve(response.data);
                }).catch(e => {
                    console.log(e);
                    resolve("invaild");
                })
        } catch (err) {
            resolve("invaild");
        }
    });
}

liveServer.listen(port, '0.0.0.0', () => {
    console.log('Server running at http://0.0.0.0:3005');
});
