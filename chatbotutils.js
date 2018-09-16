//	config variables
var ACCESS_KEY_ID = 'XXX';
var SECRET_ACCESS_KEY = 'YYY';
var S3_BUCKET_NAME = 'allergicpatients';
var REKOGNITION_FACE_COLLECTION_ID = 'allergicpatients';
    
var polly;
var lex;
var lexUserId = 'user' + Math.random();
var s3;
var bucketUrl;
var dynamoDb;
var dynamoDbDocClient;
var rekognition;

function initAWS(region) {
    AWS.config.region = region;
    AWS.config.accessKeyId = ACCESS_KEY_ID;
    AWS.config.secretAccessKey = SECRET_ACCESS_KEY;
}

function initPolly(region) {
    polly = new AWS.Polly({ region: region});
}

function initLex(region) {
    lex = new AWS.LexRuntime({
        region: region
    });
}

function initS3(region, bucketName) {
    s3 = new AWS.S3({
        params: {Bucket: bucketName}
    });
    bucketUrl = s3.endpoint.href + bucketName;
    console.log("S3 bucketUrl=" + bucketUrl);
}

function initDynamoDB(region) {
    dynamoDB = new AWS.DynamoDB({ region: region});
    dynamoDBDocClient = new AWS.DynamoDB.DocumentClient({service: dynamoDB});
}

function initRekognition(region) {
    rekognition = new AWS.Rekognition({ region: region});
}

function playAudioFromUrl(url, finishHandler) {
    setSpeechStatus('Speaking...');
    var audio = new Audio(url);
    audio.onended = function() { 
        if (finishHandler)
            finishHandler();
    }
    audio.play();
}

function speak(txt, finishHandler) {
    var params = {
        OutputFormat: 'mp3',
        Text: txt,
        VoiceId: 'Joanna',
    };
    
    polly.synthesizeSpeech(params, function(err, data) {
        if (err)
            console.log(err, err.stack);
        else {
            var uInt8Array = new Uint8Array(data.AudioStream);
            var arrayBuffer = uInt8Array.buffer;
            var blob = new Blob([arrayBuffer]);
            var url = URL.createObjectURL(blob);
            
            playAudioFromUrl(url, finishHandler);
        }
    });		
}

function savePatient(patient) {
    var params = {
        TableName : 'Patient',
        Item: patient
    };
    dynamoDBDocClient.put(params, function(err, data) {
        if (err)
            console.log(err, err.stack);
        else {
            playChatResponse('Patient "' + patient.name + '" added successfully. What would you like to do ?', function () {
                $("#output").hide();
                startRecording();
            });
        }
    });	
}

function getPatient(id, handler) {
    var params = {
        TableName : 'Patient',
        Key: {
            patientId: id
        }
    };
    dynamoDBDocClient.get(params, function(err, data) {
        if (err)
            console.log(err, err.stack);
        else
            handler(data.Item);
    });	
}

var patientToAdd;
var pictureMode = 'check';

function addPatientClicked(patient) {
    patientToAdd = patient;
    $("#camera").show();
    $("#output").hide();
    pictureMode = 'add';
    //setTimeout(takePicture, 2000);
}

function addDummy() {
    var pId = 'dummy';
    addPatientClicked({ patientId: pId,  name: pId, allergen: 'pennicilin'});
}

function checkPatientClicked() {
    $("#camera").show();
    $("#output").hide();
    pictureMode = 'check';
    //setTimeout(takePicture, 2000);
}

function handleCheckPatientResponse(patient) {
    if (!patient) {
        playChatResponse("Patient not found. What would like you to do ?", function () {
            $("#output").hide();
            startRecording();
        });
    }
    else {
        photo.setAttribute('src', patient.imageUrl);
        var allergyMessage = 'has no allergy';
        if (patient.allergen !== 'none')
            allergyMessage = 'has allergy to "' + patient.allergen + '"';
        var response = 'Patient "' + patient.name + '" ' + allergyMessage + '. What would you like to do ?';
        playChatResponse(response, function () {
            $("#output").hide();
            startRecording();
        });
    }
}

function checkPatient(blob) {
    var arrayBuffer;
    var fileReader = new FileReader();
    fileReader.onload = function() {
        var arrayBuffer = this.result;
        var params = {
            CollectionId: REKOGNITION_FACE_COLLECTION_ID, 
            FaceMatchThreshold: 80, 
            Image: {
                Bytes: arrayBuffer
            }, 
            MaxFaces: 1
        };
        rekognition.searchFacesByImage(params, function(err, data) {
            if (err) console.log(err, err.stack); // an error occurred
            else {
                var patientId = '';
                if (data.FaceMatches.length == 1)
                    patientId = data.FaceMatches[0].Face.ExternalImageId;
                if (patientId == '')
                    playChatResponse("Patient not found. What whould like you to do ?", 
                        function () {
                            $("#output").hide();
                            startRecording();
                        }
                    );
                else
                    getPatient(patientId, handleCheckPatientResponse);
            }		
        });
    };
    fileReader.readAsArrayBuffer(blob);
 }

function uploadPatientPicture(fileName, imageBlob){
    s3.upload({
        Key: fileName,
        Body: imageBlob,
        ACL: 'public-read'
    }, function(err, data) {
        if (err) {
            return alert('There was an error uploading your photo: ', err.message);
        }
        else {
            var imageUrl = bucketUrl + "/" + fileName;

            patientToAdd.imageUrl = imageUrl;
            patientToAdd.s3File = fileName;
            
            savePatient(patientToAdd);
       }		 
    });		
}

var speechRecorder = {};

function stopRecording() {
    speechRecorder.recorder.stop();
}
function startRecording() {
    setSpeechStatus('Listening...');
    speechRecorder.recorder.start();
    setTimeout(stopRecording, 4000);
}
function playLexResponse(stream, finishHandler) {
    var uInt8Array = new Uint8Array(stream);
    var arrayBuffer = uInt8Array.buffer;
    var blob = new Blob([arrayBuffer]);
    var url = URL.createObjectURL(blob);
    
    playAudioFromUrl(url, finishHandler);
}

function handleLexResponse(res) {
    replaceChatAudioInputLine(res.inputTranscript);
    if (res.dialogState !== 'ReadyForFulfillment') {
        addChatBotResponse(res.message);
        playLexResponse(res.audioStream, startRecording);
    }
    else {
        if (res.intentName === 'CheckPatient') {
            playChatResponse('OK. I will check the patient after taking the picture. Click video to take picture.', checkPatientClicked);
        }
        else if (res.intentName === 'AddPatient') {
            playChatResponse('OK. I will add this patient after taking the picture. Click video to take picture.', function() {
                addPatientClicked({ patientId: 'patient_' + Math.random(),  name: res.slots.PatientName, allergen: res.slots.Allergen });
              });
        }
       }
}

function sendAudioToLex(audioData) {
    setSpeechStatus('Analyzing...');
    addChatAudioInputLine();
    
    var params = {
        botAlias: '$LATEST',
        botName: 'AllergyChecker',
        contentType: 'audio/x-l16; sample-rate=16000',
        userId: lexUserId,
        accept: 'audio/mpeg',
        inputStream: audioData
    };
    
    //params.inputStream = ...;
    lex.postContent(params, function(err, data) {
        if (err) {
            alert("Can't send audio.");
            startRecording();
        } else {
            handleLexResponse(data);
        }
    });
}

function reSample(audioBuffer, targetSampleRate, onComplete) {
    var channel = audioBuffer.numberOfChannels;
    var samples = audioBuffer.length * targetSampleRate / audioBuffer.sampleRate;
    
    var offlineContext = new OfflineAudioContext(channel, samples, targetSampleRate);
    var bufferSource = offlineContext.createBufferSource();
    bufferSource.buffer = audioBuffer;
    
    bufferSource.connect(offlineContext.destination);
    bufferSource.start(0);
    offlineContext.startRendering().then(function(renderedBuffer){
        onComplete(renderedBuffer);
    })
}

var SILENCE_THRESHOLD = 0.04;

function removeSilence(buffer) {
    var l = buffer.length;
    var nonSilenceStart = 0;
    var nonSilenceEnd = l;
    while (nonSilenceStart < l) {
        if (Math.abs(buffer[nonSilenceStart]) > SILENCE_THRESHOLD)
            break;
        nonSilenceStart++;
    }
    while (nonSilenceEnd > nonSilenceStart) {
        if (Math.abs(buffer[nonSilenceEnd]) > SILENCE_THRESHOLD)
            break;
        nonSilenceEnd--;
    }
    var retBuffer = buffer;
    if (nonSilenceStart != 0 || nonSilenceEnd != l) {
        retBuffer = buffer.subarray(nonSilenceStart, nonSilenceEnd);
    }
    return retBuffer;
}

function convertFloat32ToInt16(buffer) {
    var l = buffer.length;
    var buf = new Int16Array(l);
    while (l--) {
        buf[l] = Math.min(1, buffer[l]) * 0x7FFF;
    }
    return buf.buffer;
}

function initSpeechRecording() {
    navigator.mediaDevices.getUserMedia({
        audio: true
    }).then(function onSuccess(stream) {
        var data = [];

        speechRecorder.recorder = new MediaRecorder(stream);
        speechRecorder.audioContext = new AudioContext();

        speechRecorder.recorder.ondataavailable = function(e) {
            data.push(e.data);
        };

        speechRecorder.recorder.onerror = function(e) {
            throw e.error || new Error(e.name);
        }

        speechRecorder.recorder.onstart = function(e) {
            data = [];
        }

        speechRecorder.recorder.onstop = function(e) {
            setSpeechStatus('Checking silence...');
            var blobData = new Blob(data, {type: 'audio/x-l16'});
            var reader = new FileReader();

            reader.onload = function() {
                speechRecorder.audioContext.decodeAudioData(reader.result, function(buffer) {
                    reSample(buffer, 16000, function(newBuffer) {
                        var trimmedBuffer = removeSilence(newBuffer.getChannelData(0));
                        if (trimmedBuffer.length > 0) // if its not fully silence, send to Lex
                            sendAudioToLex(convertFloat32ToInt16(trimmedBuffer));
                        else 
                            startRecording();
                    });
                });
            };
            reader.readAsArrayBuffer(blobData);
        }
    });
}

var lastAudioInputId = 0;

function addChatAudioInputLine() {
    var row$ = $('<p id="audioInput' + ++lastAudioInputId + '" class="me">Audio input</p>');
    $('#chat').append(row$);
    $("#chat").scrollTop($("#chat")[0].scrollHeight);
}
function replaceChatAudioInputLine(txt) {
    $('#audioInput' + lastAudioInputId).html(txt);
}
function addChatBotResponse(txt) {
    var row$ = $('<p class="bot">' + (txt || '&nbsp;') + '</p>');
    $('#chat').append(row$);
    $("#chat").scrollTop($("#chat")[0].scrollHeight);
}
function playChatResponse(txt, callback) {
    addChatBotResponse(txt);
    speak(txt, callback);
}
function setSpeechStatus(txt) {
    $('#speechStatus').html(txt);
}

var videoSource = null;
var video = null;
var canvas = null;
var photo = null;

var width = 0;    // We will scale the photo width to this
var height = 0;     // This will be computed based on the input stream

// |streaming| indicates whether or not we're currently streaming
// video from the camera. Obviously, we start at false.

var streaming = false;

function initImageCapture() {
    videoSource = document.getElementById('videoSource');
    video = document.getElementById('video');
    canvas = document.getElementById('canvas');
    photo = document.getElementById('photo');
    
    var selectedStream = null;
    var videoSourceOnChange = function () {
        if (selectedStream) {
            selectedStream.getTracks().forEach(function(track) {
                track.stop();
            });
        }
        var constraints = {
            audio: false,
            video: {
                optional: [{
                    sourceId: videoSource.value
                }]
            }
        };
        navigator.mediaDevices.getUserMedia(constraints).then(function onSuccess(stream) {
            selectedStream = stream;
            video.srcObject = stream;
        });
    };
    videoSource.onchange = videoSourceOnChange;
    
    video.addEventListener('canplay', function(ev){
        if (!streaming) {
            //height = video.videoHeight / (video.videoWidth/width);
            height = video.videoHeight;
            width = video.videoWidth;
            
            // Firefox currently has a bug where the height can't be read from
            // the video, so we will make assumptions if this happens.
            
            if (isNaN(height)) {
              height = width / (4/3);
            }
            
            video.setAttribute('width', width);
            video.setAttribute('height', height);
            canvas.setAttribute('width', width);
            canvas.setAttribute('height', height);
            output.setAttribute('width', width);
            output.setAttribute('height', height);
            streaming = true;
        }
    }, false);
    
    var backCameraIndex = -1;
    
    navigator.mediaDevices.enumerateDevices().then(function (deviceInfos) {
        for (var i = 0; i !== deviceInfos.length; ++i) {
            var deviceInfo = deviceInfos[i];
            if (deviceInfo.kind === 'videoinput') {
                var option = document.createElement('option');
                option.value = deviceInfo.deviceId;
                option.text = deviceInfo.label || 'camera ' + (videoSource.length + 1);
                if (option.text.indexOf('back') != -1 || option.text.indexOf('rear') != -1)
                    backCameraIndex = videoSource.childElementCount;
                videoSource.appendChild(option);
            }
        }
    }).then(function() { 
        if (backCameraIndex != -1) // prefer back camera on mobil devices
            videoSource.selectedIndex = backCameraIndex;
    }).then(videoSourceOnChange);
    
    clearphoto();
}

// Fill the photo with an indication that none has been
// captured.
function clearphoto() {
    var context = canvas.getContext('2d');
    context.fillStyle = "#AAA";
    context.fillRect(0, 0, canvas.width, canvas.height);
    
    var data = canvas.toDataURL('image/png');
    photo.setAttribute('src', data);
}

// Capture a photo by fetching the current contents of the video
// and drawing it into a canvas, then converting that to a PNG
// format data URL. By drawing it on an offscreen canvas and then
// drawing that to the screen, we can change its size and/or apply
// other changes before drawing it.
function takePicture() {
    var context = canvas.getContext('2d');
    
    if (width && height) {
        canvas.width = width;
        canvas.height = height;
        context.drawImage(video, 0, 0, width, height);
            
        var data = canvas.toDataURL('image/png');
        photo.setAttribute('src', data);
    
        $("#camera").hide();
        $("#output").show();
              
        canvas.toBlob(function (blob) {
            if (pictureMode === 'add') {
                var fileName = "patient_" + (100000 * Math.random()) + "_capture.png";
                uploadPatientPicture(fileName, blob);
            }
            else {
                playChatResponse('Checking patient, please wait...', function () {
                    checkPatient(blob);
                });
            }
        });
    } else {
        clearphoto();
    }
}

var userPool;

function initDashboard(region) {
    $(".chatOuter").show();
    $(".dashboard-page").show();
    
    initAWS(region);
    initPolly(region);
    initLex(region);
    initS3(region, S3_BUCKET_NAME);
    initDynamoDB(region);
    initRekognition(region);

    initSpeechRecording();
    playChatResponse('Welcome. You can "add" or "check" patients. What would you like to do ?', startRecording);
    initImageCapture();
}

function initPage() {
    initDashboard('us-east-1');
}