var WebRTCProxy			= require("./WebRTCProxy.js");
var MediaStreamTrack		= require("./MediaStreamTrack.js");
var RTCSessionDescription	= require("./RTCSessionDescription.js");
var RTCIceCandidate		= require("./RTCIceCandidate.js");
var RTCRtpSender		= require("./RTCRtpSender.js");
var RTCRtpReceiver		= require("./RTCRtpReceiver.js");
var RTCRtpTransceiver		= require("./RTCRtpTransceiver.js");
var RTCStatsReport		= require("./RTCStatsReport.js");
var DataChannel			= require("./RTCDataChannel.js");
var Map				= require("es6-map");
var Promise			= require("promise-polyfill");
var InvalidStateError           = require("./InvalidStateError.js");
var EventTarget			= require("./EventTarget.js").EventTarget;
var defineEventAttribute	= require("./EventTarget.js").defineEventAttribute;

/*
[Constructor(optional RTCConfiguration configuration),Exposed=Window]
interface RTCPeerConnection : EventTarget {
    Promise<RTCSessionDescriptionInit> createOffer(optional RTCOfferOptions options);
    Promise<RTCSessionDescriptionInit> createAnswer(optional RTCAnswerOptions options);
    Promise<void>                      setLocalDescription(RTCSessionDescriptionInit description);

    readonly attribute RTCSessionDescription? localDescription;
    readonly attribute RTCSessionDescription? currentLocalDescription;
    readonly attribute RTCSessionDescription? pendingLocalDescription;

    Promise<void>                      setRemoteDescription(RTCSessionDescriptionInit description);

    readonly attribute RTCSessionDescription? remoteDescription;
    readonly attribute RTCSessionDescription? currentRemoteDescription;
    readonly attribute RTCSessionDescription? pendingRemoteDescription;

    Promise<void>                      addIceCandidate((RTCIceCandidateInit or RTCIceCandidate) candidate);

    readonly attribute RTCSignalingState      signalingState;
    readonly attribute RTCIceGatheringState   iceGatheringState;
    readonly attribute RTCIceConnectionState  iceConnectionState;
    readonly attribute RTCPeerConnectionState connectionState;
    readonly attribute boolean?               canTrickleIceCandidates;
    static sequence<RTCIceServer>      getDefaultIceServers();
    RTCConfiguration                   getConfiguration();
    void                               setConfiguration(RTCConfiguration configuration);
    void                               close();

	attribute EventHandler           onnegotiationneeded;
	attribute EventHandler           onicecandidate;
	attribute EventHandler           onicecandidateerror;
	attribute EventHandler           onsignalingstatechange;
	attribute EventHandler           oniceconnectionstatechange;
	attribute EventHandler           onicegatheringstatechange;
	attribute EventHandler           onconnectionstatechange;
};
*/

const RTCIceTransportPolicy	= ["relay","all"];
const RTCBundlePolicy		= ["balanced","max-compat","max-bundle"];
const RTCRtcpMuxPolicy		= ["negotiate","require"];
const RTCIceCredentialType	= ["password","oauth"];

//Check if a value is valid in an enum
function check(value, valid)
{
	for (let i=0;i<valid.length;++i)
		if (valid[i]===value)
			return;
	throw new TypeError(value + " not in " + JSON.stringify(valid));
}

function checkRange(value,min,max)
{
	if (value<min || value>max)
		throw new TypeError(value + " not in [" + min + ","  + max + "]");
}

function checkNotNull(value)
{
	if (value===null)
		throw new TypeError("Null not allowed");
}

function checkArray(value)
{
	if (!Array.isArray(value))
		throw new TypeError("Must be an array");
}

function createRTCConfiguration(configuration)
{
	/*
	 *
	dictionary RTCConfiguration {
		sequence<RTCIceServer>   iceServers;
		RTCIceTransportPolicy    iceTransportPolicy = "all";
		RTCBundlePolicy          bundlePolicy = "balanced";
		RTCRtcpMuxPolicy         rtcpMuxPolicy = "require";
		DOMString                peerIdentity;
		sequence<RTCCertificate> certificates;
		[EnforceRange]
		octet                    iceCandidatePoolSize = 0;
	};  
	*/
	//Set configuration with default values
	const sanitized = Object.assign({
			iceServers		: undefined,
			iceTransportPolicy	: "all",
			bundlePolicy		: "balanced",
			rtcpMuxPolicy		: "require",
			iceCandidatePoolSize	: 0,
			certificates		: undefined
		},
		//Remove undefined objects
		configuration ? JSON.parse(JSON.stringify(configuration)) : {}
	);
	//Check valid values
	checkNotNull(sanitized.iceServers);
	
	//Check array
	if (Array.isArray(sanitized.iceServers))
	{
		//Check each one
		for (var i=0;i<sanitized.iceServers.length;++i)
		{
			/*
			 * 
			 dictionary RTCIceServer {
				required (DOMString or sequence<DOMString>) urls;
					 DOMString                          username;
					 (DOMString or RTCOAuthCredential)  credential;
					 RTCIceCredentialType               credentialType = "password";
			};
			 */
			//Set defautls
			let iceServer = sanitized.iceServers[i] = Object.assign({
					credentialType: "password"
				},
				sanitized.iceServers[i]
			);
			//Check it is not null
			checkNotNull(iceServer.urls);
			//If it is a sring fallback
			if (typeof iceServer.urls === "string")
				//Arraify
				iceServer.urls = [iceServer.urls];
			checkArray(iceServer.urls);
		}
	}
	//Check the others
	check(sanitized.iceTransportPolicy,RTCIceTransportPolicy);
	check(sanitized.bundlePolicy,RTCBundlePolicy);
	check(sanitized.rtcpMuxPolicy,RTCRtcpMuxPolicy);
	checkRange(sanitized.iceCandidatePoolSize,0,255);
	//Done
	return sanitized;
}

function createEvent(name) {
	//If fired on unload
	if (!document)
		return;
	var e = document.createEvent("Event");
	e.initEvent(name, false, false);
	return e;
}

var RTCPeerConnection = function()
{
	var self = this;
	//Init event targetr
	EventTarget.call(this);
	
	//Create private args
	var priv = this.priv = {};
	
	//Set configuration with default values
	priv.configuration = createRTCConfiguration(arguments.length ? JSON.parse(JSON.stringify(arguments[0])) : {});

	//Other internal data
	priv.senders		= new Map();
	priv.receivers		= new Map();
	priv.transceivers	= new Map();
	priv.pending		= [];
	priv.remoteStreams	= new Map();
	priv.lastOffer		= null;
	priv.lastAnswer		= null;
	priv.isClosed		= false;
	
	var signalingState	= "stable";
	var iceGatheringState	= "new";
	var iceConnectionState	= "new";
	var connectionState	= "new";
	
	//TODO: Implement this
	var canTrickleIceCandidates = undefined;
	
	function toSessionDescription(sdp) { return typeof sdp==="unknown" ? new RTCSessionDescription(sdp.toArray()) : null; }
	
	//Define read only properties for each attribute
	//The localDescription attribute must return pendingLocalDescription if it is not null and otherwise it must return currentLocalDescription .
	Object.defineProperty(this, 'localDescription'		, { enumerable: true, configurable: false, get: function() { return toSessionDescription(priv.pc.localDescription);		}});
	Object.defineProperty(this, 'currentLocalDescription'	, { enumerable: true, configurable: false, get: function() { return toSessionDescription(priv.pc.currentLocalDescription);	}});
	Object.defineProperty(this, 'pendingLocalDescription'	, { enumerable: true, configurable: false, get: function() { return toSessionDescription(priv.pc.pendingLocalDescription);	}});

	Object.defineProperty(this, 'remoteDescription'		, { enumerable: true, configurable: false, get: function() { return toSessionDescription(priv.pc.remoteDescription);		}});
	Object.defineProperty(this, 'currentRemoteDescription'	, { enumerable: true, configurable: false, get: function() { return toSessionDescription(priv.pc.currentRemoteDescription);	}});
	Object.defineProperty(this, 'pendingRemoteDescription'	, { enumerable: true, configurable: false, get: function() { return toSessionDescription(priv.pc.pendingRemoteDescription);	}});

	
	Object.defineProperty(this, 'signalingState'		, { enumerable: true, configurable: false, get: function() { return signalingState;		}});
	Object.defineProperty(this, 'iceGatheringState'		, { enumerable: true, configurable: false, get: function() { return iceGatheringState;		}});
	Object.defineProperty(this, 'iceConnectionState'	, { enumerable: true, configurable: false, get: function() { return iceConnectionState;		}});
	Object.defineProperty(this, 'connectionState'		, { enumerable: true, configurable: false, get: function() { return connectionState;		}});
	
	Object.defineProperty(this, 'canTrickleIceCandidates'	, { enumerable: true, configurable: false, get: function() { return canTrickleIceCandidates;	}});
	
	
	function fire(name) {
		self.dispatchEvent(createEvent(name));
	}
	
	//Cache
	priv.cacheRtpSender = function(sender,track) 
	{
		var rtpSender;
		
		//Check if we already had it
		if (!priv.senders.has(sender.id))
		{
			//Create sender
			rtpSender = new RTCRtpSender(sender, track, self);

			//Add to senders
			priv.senders.set(sender.id,rtpSender);
		} else {
			//Get it from cache
			rtpSender = priv.senders.get(sender.id);
			//If we need to update track
			if (track)
				//Set track
				rtpSender.priv.track = track;
		}
		//Done
		return rtpSender;
	};
	
	priv.cacheRtpReceiver = function(receiver, track)
	{
		var rtpReceiver;
		
		//Check if we already had it
		if (!priv.receivers.has(receiver.id))
		{
			//Create sender
			rtpReceiver = new RTCRtpReceiver(receiver, track, self);

			//Add to senders
			priv.receivers.set(receiver.id,rtpReceiver);
		} else {
			//Get it from cache
			rtpReceiver = priv.receivers.get(receiver.id);
			//If we need to update track
			if (track)
				//Set track
				rtpReceiver.priv.track = track;
		}
		//Done
		return rtpReceiver;
	};
	
	priv.cacheRtpTransceiver = function(transceiver)
	{
		var rtpTransceiver;
		//Check if we already have it
		if (!priv.transceivers.has(transceiver.mid)) 
		{
			//Get sender and receiver from cache
			var rtpSender	= priv.cacheRtpSender(transceiver.sender);
			var rtpReceiver = priv.cacheRtpReceiver(transceiver.receiver);
			
			//Create transceiver
			var rtpTransceiver = new RTCRtpTransceiver(transceiver,rtpSender,rtpReceiver);

			//Add to cache
			priv.transceivers.set(transceiver.mid	, rtpTransceiver);
		} else {
			//Get it
			rtpTransceiver = priv.transceivers.get(transceiver.mid);
		}
		
		return rtpTransceiver;
	};
	
	// Create new native pc
	priv.pc = WebRTCProxy.createPeerConnection(priv.configuration);
	
	//Event handlers
	priv.pc.onnegotiationneeded = function() {
		fire("negotiationneeded");
	};
	priv.pc.onicecandidate = function(candidate,sdpMid,sdpMLineIndex,foundation,component,priority,ip,protocol,port,type,tcpType,relatedAddress,relatedPort,usernameFragment,url) {
		var e = createEvent("icecandidate");
		if (candidate)
			e.candidate = new RTCIceCandidate({
				candidate	: candidate,
				sdp		: sdpMid,
				sdpMLineIndex	: sdpMLineIndex,
				ext: {
					foundation	: foundation,
					component	: component,
					priority	: priority,
					ip		: ip,
					protocol	: protocol,
					port		: port,
					type		: type,
					tcpType		: tcpType,
					relatedAddress	: relatedAddress,
					relatedPort	: relatedPort
				},
				usernameFragment : usernameFragment
			});
		else
			e.candidate = null;
		e.url = url;
		self.dispatchEvent(e);
	};
	priv.pc.onicecandidateerror = function() {
		fire("icecandidateerror");
	};
	priv.pc.onsignalingstatechange = function(state) {
		signalingState = state;
		fire("signalingstatechange");
		if ("closed"===state)
		{
			priv.isClosed = true;
			delete(priv.pc);
		}
	};	
	priv.pc.oniceconnectionstatechange = function(state) {
		iceConnectionState = state;
		fire("iceconnectionstatechange");
	};	
	priv.pc.onicegatheringstatechange = function(state) {
		iceGatheringState = state;
		fire("icegatheringstatechange");
	};	
	priv.pc.onconnectionstatechange = function(state) {
		connectionState = state;
		fire("connectionState");
	};
	
	priv.pc.onaddstream = function (label) {
		
		//Check if didn't have it already
		if (!priv.remoteStreams.has(label))
			//Create and add new stream
			priv.remoteStreams.set(label, new MediaStream(label));
	};
	
	priv.pc.onremovestream = function (label) {
		//Delete from remote stream list
		priv.remoteStreams.delete(label);
	};
	
	priv.pc.ondatachannel = function (dataChannel) {
		//Create event
		var event = createEvent("datachannel");
		//Create datachannel
		event.channel = new DataChannel(dataChannel);
		//Fire event
		self.dispatchEvent(event);
	};
	
	priv.pc.onaddtrack = function (transceiver) {
		//Add to list of pending trasnceivers
		priv.pending.push(transceiver);
	};
	
	priv.pc.onremovetrack = function (receiver) {
		//Cache native objects 
		var rtpReceiver	= priv.cacheRtpReceiver(receiver);
		//Create evnet
		var event = createEvent("ended");
		//Fire it on track
		rtpReceiver.priv.track.dispatchEvent(event);
		//remove track
		delete(rtpReceiver.priv.track);
	};
	
	priv.onunload = window.addEventListener ("unload",function(){
		if (!priv.isClosed)
			priv.pc.close ();
	});
};
	
//Inherit from Event Target
RTCPeerConnection.prototype = Object.create(EventTarget.prototype, {
	constructor: { 
		value		: RTCPeerConnection, 
		configurable	: true,
		writable	: true 
	}
});
RTCPeerConnection.__proto__ = EventTarget;

// Define Event Handlers
defineEventAttribute(RTCPeerConnection.prototype, "negotiationneeded");
defineEventAttribute(RTCPeerConnection.prototype, "icecandidate");
defineEventAttribute(RTCPeerConnection.prototype, "icecandidateerror");
defineEventAttribute(RTCPeerConnection.prototype, "signalingstatechange");
defineEventAttribute(RTCPeerConnection.prototype, "iceconnectionstatechange");
defineEventAttribute(RTCPeerConnection.prototype, "icegatheringstatechange");
defineEventAttribute(RTCPeerConnection.prototype, "connectionstatechange");
defineEventAttribute(RTCPeerConnection.prototype, "addtrack");

RTCPeerConnection.prototype.getConfiguration = function()
{
	return this.priv.configuration;
};

RTCPeerConnection.prototype.setConfiguration = function(configuration)
{
	var priv = this.priv;
	if (!priv.pc || priv.isClosed)
		throw new InvalidStateError();
	
	//Get configuration object from input
	const sanitized = createRTCConfiguration(configuration);
	
	try {
		//Try to set it
		priv.pc.setConfiguration(sanitized);
	} catch(error) {
		//Launch InvalidModificationError
		var operationError = new Error(error);
		operationError.name = "InvalidModificationError";
		operationError.code = 13;
		throw operationError;
	}
	//Store new configuration
	priv.configuration = sanitized;
};


RTCPeerConnection.getDefaultIceServers = function()
{
	return [];
};

RTCPeerConnection.prototype.createOffer = function(options) 
{
	var priv = this.priv;
	
	return new Promise(function(resolve,reject) {
		if (!priv.pc || priv.isClosed)
			throw new InvalidStateError();
		priv.pc.createOffer(
			function(type,sdp){
				priv.lastOffer = sdp;
				resolve({
					type: type,
					sdp : sdp
				});
			},
			function() {
				 reject(new InvalidStateError());
			},
			options
		);
	});
};

RTCPeerConnection.prototype.createAnswer = function(options) 
{
	var self = this;
	var priv = this.priv;
	
	return new Promise(function(resolve,reject) {
		if (!priv.pc || priv.isClosed)
			throw new InvalidStateError();
		if (self.remoteDescription===null)
			throw new InvalidStateError();
		priv.pc.createAnswer(
			function(type,sdp){
				priv.lastAnswer = sdp;
				resolve({
					type: type,
					sdp : sdp
				});
			},
			function() {
				 reject(new InvalidStateError());
			},
			options
		);
	});
};

RTCPeerConnection.prototype.setLocalDescription = function(description)
{
	var priv = this.priv;
	
	//If description.sdp is the empty string and description.type is "answer" or "pranswer", set description.sdp to lastAnswer.
	if (!description.sdp &&  ("answer"=== description.type || "pranser"===description.type))
		description.sdp = priv.lastAnswer;
	
	//If description.sdp is the empty string and description.type is "offer", set description.sdp to lastOffer.
	if (!description.sdp && "offer"=== description.type)
		description.sdp = priv.lastOffer;
	
	return new Promise(function(resolve,reject) {
		if (!priv.pc || priv.isClosed)
			throw new InvalidStateError();
		priv.pc.setLocalDescription(resolve,
			function() {
				 reject(new InvalidStateError());
			},
			description
		);
	});
};

RTCPeerConnection.prototype.setRemoteDescription = function(description)
{
	var self = this;
	var priv = this.priv;
	
	return new Promise(function(resolve,reject) {
		if (!priv.pc || priv.isClosed)
			throw new InvalidStateError();
		priv.pc.setRemoteDescription(
			function() {

				//Cache transceivers
				self.getTransceivers();

				//For each pending transceiver
				for (var j=0; j<priv.pending.length; ++j)
				{
					//Get transceiver
					var rtpTransceiver = priv.transceivers.get(priv.pending[j].mid);

					//Get native receiver
					var receiver = rtpTransceiver.receiver.priv.receiver;

					//Get streams ids
					var streams = [];
					var streamIds = receiver.getStreamIds().toArray();

					//Create new track object from native
					var track = new MediaStreamTrack(receiver.track) 

					//For each stream
					for (var i = 0; i<streamIds.length; ++i)
					{
						var stream;
						//Get id
						var streamId = streamIds[i];
						//Check if didn't hrave it already
						if (!priv.remoteStreams.has(streamId))
						{
							//Create 
							stream = new MediaStream(streamId);
							//and add new stream
							priv.remoteStreams.set(streamId, stream);
						} else {
							//Get stream
							stream = priv.remoteStreams.get(streamId);
						}
						//Add track to stream
						stream.addTrack(track);
						//Add to streams
						streams.push(stream);
					}

					//Set track
					rtpTransceiver.receiver.priv.track = track;

					//Launch async so all tracks can be filled on the streams
					setTimeout(function(){
						//Create evnet
						var event = createEvent("track");
						//Add data
						event.track = track;
						event.receiver =  rtpTransceiver.receive;
						event.transceiver = rtpTransceiver;
						event.streams = streams;
						//Fire it
						self.dispatchEvent(event);
					},0);
				}
				//Clean pending transceivers
				priv.pending = [];

				//Done
				resolve();
			},
			function() {
				reject(new InvalidStateError());
			},
			description
		);
	});
};

RTCPeerConnection.prototype.addIceCandidate = function(candidate) 
{
	var self = this;
	var priv = this.priv;
	//1.  Let candidate be the method's argument.
	//2.  Let connection be the ``[`RTCPeerConnection`](#dom-rtcpeerconnection)`` object on which the method was invoked.
	//3.  If both sdpMid and sdpMLineIndex are `null`, return a promise [rejected](#dfn-rejected) with a newly [created](https://www.w3.org/TR/2016/REC-WebIDL-1-20161215/#dfn-create-exception) `TypeError`.
	if (!candidate || typeof candidate.sdpMid!=="string" && typeof candidate.sdpMLineIndex!=="number")
		return Promise.reject(new TypeError());

	//4.  Return the result of [enqueuing](#enqueue-an-operation) the following steps to connection's operation queue:
	return new Promise(function(resolve,reject) {
		//1.  If ``[`remoteDescription`](#dom-rtcpeerconnection-remotedescription)`` is `null` return a promise [rejected](#dfn-rejected) with a newly [created](https://www.w3.org/TR/2016/REC-WebIDL-1-20161215/#dfn-create-exception) `InvalidStateError`.
		if (self.remoteDescription===null)
			throw new InvalidStateError();
		
		/*
		2.  Let p be a new promise.   
		3.  If candidate.sdpMid is not null, run the following steps:
		    1.  If candidate.sdpMid is not equal to the mid of any media description in ``[`remoteDescription`](#dom-rtcpeerconnection-remotedescription)`` , [reject](#dfn-rejected) p with a newly [created](https://www.w3.org/TR/2016/REC-WebIDL-1-20161215/#dfn-create-exception) `OperationError` and abort these steps.
		4.  Else, if candidate.sdpMLineIndex is not null, run the following steps:
		    1.  If candidate.sdpMLineIndex is equal to or larger than the number of media descriptions in ``[`remoteDescription`](#dom-rtcpeerconnection-remotedescription)`` , [reject](#dfn-rejected) p with a newly [created](https://www.w3.org/TR/2016/REC-WebIDL-1-20161215/#dfn-create-exception) `OperationError` and abort these steps.
		5.  If `candidate.usernameFragment` is neither `undefined` nor `null`, and is not equal to any username fragment present in the corresponding [media description](#dfn-media-description) of an applied remote description, [reject](#dfn-rejected) p with a newly [created](https://www.w3.org/TR/2016/REC-WebIDL-1-20161215/#dfn-create-exception) `OperationError` and abort these steps.
		6.  In parallel, add the ICE candidate candidate as described in \[[JSEP](#bib-JSEP)\] ([section 4.1.17.](https://tools.ietf.org/html/draft-ietf-rtcweb-jsep-20#section-4.1.17)). Use `candidate.usernameFragment` to identify the ICE [generation](#dfn-generation); if `usernameFragment` is null, process the candidate for the most recent ICE [generation](#dfn-generation). If `candidate.candidate` is an empty string, process candidate as an end-of-candidates indication for the corresponding [media description](#dfn-media-description) and ICE candidate [generation](#dfn-generation).
		    1.  If candidate could not be successfully added the user agent _MUST_ queue a task that runs the following steps:
			1.  If connection's [\[\[IsClosed\]\]](#dfn-x%5B%5Bisclosed%5D%5D) slot is `true`, then abort these steps.
			2.  [Reject](#dfn-rejected) p with a `DOMException` object whose `name` attribute has the value `OperationError` and abort these steps.
		    2.  If candidate is applied successfully, the user agent _MUST_ queue a task that runs the following steps:
			1.  If connection's [\[\[IsClosed\]\]](#dfn-x%5B%5Bisclosed%5D%5D) slot is `true`, then abort these steps.
			2.  If ``connection.[`pendingRemoteDescription`](#dom-rtcpeerconnection-pendingremotedescription)`` is non-null, and represents the ICE [generation](#dfn-generation) for which candidate was processed, add candidate to ``connection.[`pendingRemoteDescription`](#dom-rtcpeerconnection-pendingremotedescription)`` .
			3.  If ``connection.[`currentRemoteDescription`](#dom-rtcpeerconnection-currentremotedescription)`` is non-null, and represents the ICE [generation](#dfn-generation) for which candidate was processed, add candidate to ``connection.[`currentRemoteDescription`](#dom-rtcpeerconnection-currentremotedescription)`` .
			4.  [Resolve](#dfn-resolved) p with `undefined`.
		7.  Return p.
		*/
		try {	
			//Add ICE candidate nativelly
			priv.pc.addIceCandidate(resolve,
				function() {
					reject(new InvalidStateError());
				},
				candidate
			);
		} catch(error){
			//Launch operation error
			var operationError = new Error(error);
			operationError.name = "OperationError";
			operationError.code = 0;
			throw operationError;
		}
	});
};

RTCPeerConnection.prototype.close = function()
{

	var priv = this.priv;
	if (!priv.pc || priv.isClosed)
		throw new InvalidStateError();
	//Close it
	priv.pc.close();
	//We are closed now, we can wait until callback
	priv.isClosed = true;
	//Remove listener
	window.removeEventListener ("unload",priv.onunload);
};
/*
partial interface RTCPeerConnection {
    sequence<RTCRtpSender>      getSenders();
    sequence<RTCRtpReceiver>    getReceivers();
    sequence<RTCRtpTransceiver> getTransceivers();
    RTCRtpSender                addTrack(MediaStreamTrack track, MediaStream... streams);
    void                        removeTrack(RTCRtpSender sender);
    RTCRtpTransceiver           addTransceiver((MediaStreamTrack or DOMString) trackOrKind, optional RTCRtpTransceiverInit init);
    attribute EventHandler ontrack;
};
*/
RTCPeerConnection.prototype.addTrack = function()
{
	var priv = this.priv;
	
	if (!priv.pc || priv.isClosed)
		throw new InvalidStateError();
	
	//Parse arguments
	var track   = arguments[0];
	var streams = Array.prototype.slice.call(arguments,1);
	
	//Check if it is a track
	if (!(track.priv && track.priv.track))
		throw new TypeError("First argument must be a track");
	
	//Ensure that we are attaching to at most 1, as it is not supported in libwebrtc
	if (streams.length>1)
		throw new Error("Adding track to more than one stream is not currently supported");
	
	//Get stream label, as it is the only param needed by libwebrtc
	var label = streams.length ? streams[0].id : "";
	
	//Add native track to native object it only needs the stream label not the stream
	var sender = priv.pc.addTrack(track.priv.track, label);
	
	//Check result
	if (!sender)
		return null;
	
	//Get sender
	return priv.cacheRtpSender(sender,track);
};

RTCPeerConnection.prototype.addTransceiver = function(trackOrKind,init)
{
	var priv = this.priv;
	
	if (!priv.pc || priv.isClosed)
		throw new InvalidStateError();
	
	if (!trackOrKind)
		throw new TypeError("First argument must be a track or a string");
	
	var rtpTransceiver;
	
	//Check if it is a track or a string
	if (trackOrKind.priv && trackOrKind.priv.track) 
	{
		//Create transcevier with track
		var transceiver = priv.pc.addTransceiverTrack(trackOrKind.priv.track, init);
		//Create rtp sender for track
		priv.cacheRtpSender(transceiver.sender,trackOrKind);
		//Create transceiver
		rtpTransceiver = priv.cacheRtpTransceiver(transceiver);
	} else if (typeof trackOrKind == "string") {
		//Create transceiver for media type
		var transceiver = priv.pc.addTransceiverKind(trackOrKind, init);
		//Create transceiver
		rtpTransceiver = priv.cacheRtpTransceiver(transceiver);
	} else {
		//Error
		throw new TypeError("First argument must be a track or a string");
	}
	
	//Return 
	return rtpTransceiver;
};

 RTCPeerConnection.prototype.getTransceivers = function()
 {
	var priv = this.priv;

	if (!priv.pc || priv.isClosed)
		throw new InvalidStateError();

	 var rtpTransceivers = [];

	 //Get the transceiver objects
	 var transceivers = priv.pc.getTransceivers().toArray();

	 //Check each one
	 for (var i=0; i<transceivers.length; ++i)
	 {
		//get cached fron native
		var rtpTransceiver = priv.cacheRtpTransceiver(transceivers[i]);

		//Add cached
		rtpTransceivers.push(rtpTransceiver);
	 }

	return rtpTransceivers;
 };
 
 RTCPeerConnection.prototype.getReceivers = function()
 {
	var priv = this.priv;

	if (!priv.pc || priv.isClosed)
		throw new InvalidStateError();

	 var rtpReceivers = [];

	 //Get the transceiver objects
	 var receivers = priv.pc.getReceivers().toArray();

	 //Check each one
	 for (var i=0; i<receivers.length; ++i)
	 {
		//get cached fron native
		var rtpReceiver = priv.cacheRtpReceiver(receivers[i]);

		//Add cached
		rtpReceivers.push(rtpReceiver);
	 }

	return rtpReceivers;	 
 };
 
 RTCPeerConnection.prototype.getSenders = function()
 {
	var priv = this.priv;

	if (!priv.pc || priv.isClosed)
		throw new InvalidStateError();

	 var rtpSenders = [];

	 //Get the sender objects
	 var senders = priv.pc.getSenders().toArray();

	 //Check each one
	 for (var i=0; i<senders.length; ++i)
	 {
		//get cached fron native
		var rtpSender = priv.cacheRtpSender(senders[i]);

		//Add cached
		rtpSenders.push(rtpSender);
	 }

	return rtpSenders;	 
 };
 
 RTCPeerConnection.prototype.getStats = function(selector)
{
	
	var self = this;
	
	//Return new promise
	return new Promise(function(resolve,reject) {
		var priv = self.priv;
		
		if (!priv.pc)
			return reject(new InvalidStateError());
		
		var callback = function(json){
			//Parse json
			var stats = json!="" ? JSON.parse(json) : [];
			//Create map like stats report
			var report = new RTCStatsReport();
			//For each stat
			for (var i=0; i<stats.length; i++)
				//Add stats by id
				report.set(stats[i].id, stats[i]);
			//Resolve promise
			resolve(report);
		};
		
		//If we have selector
		if (!selector)
			//Get stats
			return priv.pc.getStats(callback,null);
		else if (selector instanceof RTCRtpSender)
			//Get stats
			return priv.pc.getStats(callback,selector.priv.sender);
		else if (selector instanceof RTCRtpReceiver)
			//Get stats
			return priv.pc.getStats(callback,selector.priv.receiver);
		//Get senders
		var senders = self.getSenders ();
		
		//For each one
		for (var i=0; i<senders.length; ++i)
			//If it is the sender for this track
			if (senders[i].track === selector)
				//Get stats for it
				return priv.pc.getStats(callback,senders[i].priv.sender);
		
		//Get receivers
		var receivers = self.getReceivers();
		
		//For each one
		for (var i=0; i<receivers.length; ++i)
			//If it is the sender for this track
			if (receivers[i].track === selector)
				//Get stats for it
				return priv.pc.getStats(callback,receivers[i].priv.receiver);
		
		//Error
		reject(new TypeError("Invalid selector"));
		
	});
};
 
 
/*
 * Legacy stream apis
 */
RTCPeerConnection.prototype.addStream = function(stream)
{
	var tracks = stream.getTracks();
	for (var i=0; i<tracks.length; ++i)
		this.addTrack(tracks[i],stream);
};

RTCPeerConnection.prototype.removeTrack = function(rtpSender)
{
	var priv = this.priv;
	
	if (!priv.pc || priv.isClosed)
		throw new InvalidStateError();
	
	//Check if sender is invalid
	if (!rtpSender || !rtpSender.priv.sender || !rtpSender.priv.track)
		throw new InvalidStateError();
	
	//Get native sender id
	var senderId = rtpSender.priv.id;
	
	//Check if senders is from this pc
	if (!priv.senders.hasOwnProperty(senderId))
		throw new InvalidStateError();
		
	//Pass the nateive object
	priv.pc.removeTrack(rtpSender.priv.sender);
	
	//Set sender track to null
	rtpSender.priv.track = null;
};

defineEventAttribute(RTCPeerConnection.prototype, "track");

/*
partial interface RTCPeerConnection {
    readonly attribute RTCSctpTransport? sctp;
    RTCDataChannel createDataChannel(USVString label,
                                     optional RTCDataChannelInit dataChannelDict);
             attribute EventHandler      ondatachannel;
};
*/
RTCPeerConnection.prototype.createDataChannel = function(label,dataChannelDict)
{
	var priv = this.priv;
	
	if (!priv.pc || priv.isClosed)
		throw new InvalidStateError();
	
	//Check if we have a string label (can be empty)
	if (typeof label !== "string") return new TypeError();
	
	//Create native datachannel
	var dataChannel = priv.pc.createDataChannel(label, dataChannelDict);
	
	//Check
	if (!dataChannel)
		return null;
	
	//Return wrapper
	return new DataChannel(dataChannel);
};



defineEventAttribute(RTCPeerConnection.prototype, "datachannel");

Object.defineProperty(RTCPeerConnection, 'RTCPeerConnection'	, { enumerable: false, configurable: true, writable: false, value: "RTCPeerConnection" });
Object.defineProperty(RTCPeerConnection, 'prototype'	, { writable:false });
module.exports = RTCPeerConnection;
