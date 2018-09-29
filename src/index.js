'use strict';

// Imports
const electron = require('electron')
const {ipcRenderer, remote} = electron
const path = require("path")
const fs = require("fs")
var Stats = require('stats-js')
var THREE = require('three')

const WarpShader = {
	uniforms: {
    "showMasked" :  { type: "i", value: 1 },
    "aspect" :  { type: "f", value: 1 },
    "mask": { type:'t', value: null },
    "diffuse": { type:'t', value: null },
	},
	vertexShader: [
    "attribute vec3 warp;",
    "uniform float aspect;",
    "varying vec2 vUv;",
    "varying vec3 vWarp;",
    "void main() {",
			"vUv = uv * vec2(aspect);",
      "vWarp = warp;",
			"gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );",
		"}"
	].join( "\n" ),
	fragmentShader: [
    "uniform int showMasked;",
    "uniform float aspect;",
    "uniform sampler2D mask;",
    "uniform sampler2D diffuse;",
    "varying vec2 vUv;",
    "varying vec3 vWarp;",
    "void main() {",
      "vec2 uvq = vec2(vWarp.x/vWarp.z, (1.-vWarp.y/vWarp.z));",
      "vec4 diffuseCol = texture2D(diffuse, uvq);",
      "vec4 maskCol = texture2D(mask, uvq);",
      "if (showMasked == 1) {",
        "maskCol.r = clamp(maskCol.r, .5, 1.);",
      "}",
      "gl_FragColor = vec4(diffuseCol.rgb*maskCol.r, diffuseCol.a*maskCol.r) + vec4(maskCol.g, maskCol.g, maskCol.g, 0.0) ;",
    "}",
	].join( "\n" )
}


// Render Target Width and Height
const BUFFER_SIZE = 2048
// Cam Settings
const FOV = 60
const ASPECT = BUFFER_SIZE / BUFFER_SIZE
const NEAR = 0.001
const FAR = 10

// Audio Analylser Fast Fourier Transform Buffer Size
const FFT_SIZE = 64
const FFT_MAG = 128

const MODEL = 'nyc.json'

function makePositionBuffer(position, bottomLeft, bottomRight, topRight, topLeft) {

		var bufferIndex = 0
    position[bufferIndex++] = bottomLeft.x
    position[bufferIndex++] = bottomLeft.y
    position[bufferIndex++] = 0
    position[bufferIndex++] = bottomRight.x
    position[bufferIndex++] = bottomRight.y
    position[bufferIndex++] = 0
    position[bufferIndex++] = topRight.x
    position[bufferIndex++] = topRight.y
    position[bufferIndex++] = 0
    position[bufferIndex++] = topLeft.x
    position[bufferIndex++] = topLeft.y
    position[bufferIndex++] = 0

    return position
}

function makeUVBuffer(uvs, bottomLeft, bottomRight, topRight, topLeft) {

		var bufferIndex = 0
    uvs[bufferIndex++] = bottomLeft.x
    uvs[bufferIndex++] = bottomLeft.y
    uvs[bufferIndex++] = bottomRight.x
    uvs[bufferIndex++] = bottomRight.y
    uvs[bufferIndex++] = topRight.x
    uvs[bufferIndex++] = topRight.y
    uvs[bufferIndex++] = topLeft.x
    uvs[bufferIndex++] = topLeft.y

    return uvs
}

function makeWarpBuffer(warp, bottomLeft, bottomRight, topRight, topLeft) {
		var ax = topRight.x - bottomLeft.x;
		var ay = topRight.y - bottomLeft.y;
		var bx = topLeft.x - bottomRight.x;
		var by = topLeft.y - bottomRight.y;
  	var cross = ax * by - ay * bx;

		if (cross != 0) {
			var cy = bottomLeft.y - bottomRight.y;
			var cx = bottomLeft.x - bottomRight.x;

			var s = (ax * cy - ay * cx) / cross;

			if (s > 0 && s < 1) {
				var t = (bx * cy - by * cx) / cross;

				if (t > 0 && t < 1) {
					//uv coordinates for texture
					var u0 = 0 // texture bottom left u
					var v0 = 0 // texture bottom left v
					var u2 = 1 // texture top right u
					var v2 = 1 // texture top right v

					var bufferIndex = 0;

					var q0 = 1 / (1 - t)
					var q1 = 1 / (1 - s)
					var q2 = 1 / t
					var q3 = 1 / s

          // bl
					warp[bufferIndex++] = u0 * q0
					warp[bufferIndex++] = v2 * q0
					warp[bufferIndex++] = q0

					warp[bufferIndex++] = u2 * q1;
					warp[bufferIndex++] = v2 * q1;
					warp[bufferIndex++] = q1;

					warp[bufferIndex++] = u2 * q2;
					warp[bufferIndex++] = v0 * q2;
					warp[bufferIndex++] = q2;

					warp[bufferIndex++] = u0 * q3;
					warp[bufferIndex++] = v0 * q3;
					warp[bufferIndex++] = q3;

				}
			}
		}
    return warp
}

function makeNormalBuffer(normal, bottomLeft, bottomRight, topRight) {

    const MULT = 32767 // MAX INT

    var pA = new THREE.Vector3(bottomLeft.x, bottomLeft.y, 0.)
    var pB = new THREE.Vector3(bottomRight.x, bottomRight.y, 0.)
    var pC = new THREE.Vector3(topRight.x, topRight.y, 0.)

    var cb = new THREE.Vector3()
    var ab = new THREE.Vector3()

    // tri 1 is enough
		cb.subVectors(pC, pB)
		ab.subVectors(pA, pB)
		cb.cross(ab)
		cb.normalize()

    cb.multiplyScalar(MULT)

    var bufferIndex = 0
    for (bufferIndex; bufferIndex<normal.length; bufferIndex+=3) {
  		normal[bufferIndex] = cb.x;
  		normal[bufferIndex+1] = cb.y;
  		normal[bufferIndex+2] = cb.z;
    }
    return normal
}

function makeQuad() {
  var t = {}
  t.scene = new THREE.Scene()
  t.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 3)
  t.camera.updateProjectionMatrix()
  t.camera.position.z = 2

  t.geometry = new THREE.BufferGeometry()

  t.bl = new THREE.Vector2(-1, -1)
  t.br = new THREE.Vector2(1, -1)
  t.tr = new THREE.Vector2(1, 1)
  t.tl = new THREE.Vector2(-1, 1)

  var position = new Float32Array(4*3)
  var warp = new Float32Array(4*3);
  var normal = new Float32Array(4*3)
  var uv = new Float32Array(4*2)

  makePositionBuffer(position, t.bl, t.br, t.tr, t.tl)
  makeWarpBuffer(warp, t.bl, t.br, t.tr, t.tl)
  makeNormalBuffer(normal, t.bl, t.br, t.tr) // from first tri only
  makeUVBuffer(
    uv,
    new THREE.Vector2(0, 0),
    new THREE.Vector2(1, 0),
    new THREE.Vector2(1, 1),
    new THREE.Vector2(0, 1)
  )
  var index = new Uint32Array([
    0, 1, 2, 2, 3, 0
  ])

	t.geometry.setIndex( new THREE.BufferAttribute(index, 1) );
  t.geometry.addAttribute('position', new THREE.BufferAttribute(position, 3));
  t.geometry.addAttribute('uv', new THREE.BufferAttribute(uv, 2, true));
  t.geometry.addAttribute('warp', new THREE.BufferAttribute(warp, 3));
	t.geometry.addAttribute('normal', new THREE.BufferAttribute( normal, 3, true ) );

  t.material = new THREE.ShaderMaterial(WarpShader)
  t.mesh = new THREE.Mesh(t.geometry, t.material)
  t.mesh.position.z = 0

  t.scene.add(t.mesh)

  t.markerGeometry = new THREE.RingBufferGeometry(.02, .04, 16, 1);
  t.markerMaterial = new THREE.MeshBasicMaterial( { color: 0xFFFFFF } );
  t.marker = new THREE.Mesh(t.markerGeometry, t.markerMaterial)
  t.marker.position.z = 1;
  t.marker.position.x = 0;
  t.marker.position.y = 0;
  t.scene.add(t.marker)

  t.updatePoints = function() {
    makePositionBuffer(position, t.bl, t.br, t.tr, t.tl)
    makeWarpBuffer(warp, t.bl, t.br, t.tr, t.tl)
    t.geometry.attributes.position.needsUpdate = true;
    t.geometry.attributes.warp.needsUpdate = true;
  }
  t.setTexture = function(texture) {
    t.material.uniforms.diffuse.value = texture
  }
  t.setMask = function(texture) {
    t.material.uniforms.mask.value = texture
  }
  return t
}

function makeInfiniteZoom() {
  var t = {}
  t.fov = 45
  t.near = 0.001
  t.far = 10000
  t.speed = 0.005
  t.angleSpeed = .001
  t.dir = 1
  t.surfaces = 28
  t.spawnDistance = .66
  t.spawnPoint = 0
  t.killPosition = -10
  t.minColor = 0x111111

  t.scene = new THREE.Scene()
  //t.scene.fog = new THREE.Fog(0x000000, t.near, t.far);
  t.ambientLight = new THREE.AmbientLight( 0x101010 ); // soft white light
  t.scene.add(t.ambientLight);
  //window.innerWidth / window.innerHeight
  //t.camera = new THREE.PerspectiveCamera( t.fov, 1, t.near, t.far)
  //t.camera.position.z = 1;

  t.model
  t.island
  t.light
  t.lightRig


  t.cameraRig

  function childByName(object, name) {
    for (var i=0; i< object.children.length ; i++) {
      var currentChild = object.children[i]
      if(currentChild.name === name) return currentChild
    }
  }

  function initMesh() {
    var loader = new THREE.ObjectLoader()
    loader.load(MODEL, function(object) {
      console.log(object)
      t.model = object
      t.island = childByName(t.model, "island")
      t.cameraRig = childByName(t.model, "CameraRig")
      t.camera = childByName(t.cameraRig, "Camera")
      t.lightRig = childByName(t.model, "LightRig")
      t.light = childByName(t.lightRig, "Lamp")
      t.light.castShadow = true
      t.light.shadow.radius = 3
      //t.light.shadow.bias =  0.0001
      t.light.shadow.mapSize.width = 2048;  // default
      t.light.shadow.mapSize.height = 2048; // default
      t.light.shadow.camera.near = 0.5;       // default
      t.light.shadow.camera.far = 100      // default
      t.scene.add(t.model)
      t.camera.updateProjectionMatrix()
    })
  }
  initMesh()


  t.animate = function(analyserBuffer) {
    if(t.model) {
      t.cameraRig.rotation.z -=  t.angleSpeed
      t.lightRig.rotation.z =  t.angleSpeed*.3471028 //t.cameraRig.rotation.z //
      if(analyserBuffer) {
        for (var i in t.island.children) {
          var currentChild = t.island.children[i]
          if(currentChild.userData.hasOwnProperty("audiotrigger") && currentChild.userData.audiotrigger > 0) {
            //console.log("scale",currentChild)
            var bufferindex = (i+analyserBuffer.length) % analyserBuffer.length
            var bufferval = analyserBuffer[bufferindex]/0xFF
            currentChild.scale.z = .5+(bufferval*currentChild.userData.audiotrigger)*.5
          }
        }
      }
    }
  }

  return t
}

function makeMask() {
  var t = {}
  t.points = [
    new THREE.Vector2(-1, -1),
    new THREE.Vector2(1, -1),
    new THREE.Vector2(1, 1),
    new THREE.Vector2(-1, 1)
  ]
  t.scene = new THREE.Scene()
  t.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 3)
  t.camera.position.z = 2;
  t.camera.updateProjectionMatrix()
  t.hasChanged = false
  t.material = new THREE.MeshBasicMaterial( { color: 0xFF0000 } );

  t.shapes = new THREE.Object3D()
  t.scene.add(t.shapes)

  t.markerGeometry = new THREE.CircleBufferGeometry(.02, 16);
  t.markerMaterial = new THREE.MeshBasicMaterial( { color: 0x00FF00 } );
  t.marker = new THREE.Mesh(t.markerGeometry, t.markerMaterial)
  t.marker.position.z = 1;
  t.marker.position.x = 0;
  t.marker.position.y = 0;
  t.scene.add(t.marker)

  t.removeAll = function() {
    for(var i = 0; i < t.shapes.children.length; i++) {
        t.shapes.remove(t.shapes.children[i])
    }
  }

  t.updatePoints = function() {
    t.removeAll()
    if(t.points.length < 3) return
    var shape = new THREE.Shape()
    shape.moveTo(t.points[t.points.length-1].x, t.points[t.points.length-1].y)
    for (var i = 0; i<t.points.length; i++) {
      shape.lineTo(t.points[i].x, t.points[i].y)
    }
    var geometry = new THREE.ShapeGeometry(shape)

    t.mesh = new THREE.Mesh( geometry, t.material )
    t.shapes.add(t.mesh)
    t.hasChanged = true
  }
  t.updateMarker = function() {
    t.hasChanged = true
  }
  t.updatePoints()
  return t
}

function makeInstallation(selector, infoSelector) {
  var t = {}
  t.selector = selector || "body"
  t.infoSelector = infoSelector


  t.quad = makeQuad()
  t.mask = makeMask()
  t.infinite = makeInfiniteZoom()

  t.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false })
  //t.renderer.setClearColor( 0xFFFFFF, 1. );
  t.renderer.setClearColor( 0x0, 1. );
  t.renderer.shadowMap.enabled = true;
  t.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  t.renderer.setPixelRatio(window.devicePixelRatio)
  t.renderer.setSize(window.innerWidth, window.innerHeight)

  t.buffer = new THREE.WebGLRenderTarget(
      BUFFER_SIZE, BUFFER_SIZE,
      { minFilter: THREE.LinearMipMapLinearFilter, magFilter: THREE.LinearFilter}
  )

  t.maskBuffer = new THREE.WebGLRenderTarget(
      BUFFER_SIZE, BUFFER_SIZE,
      { minFilter: THREE.LinearMipMapLinearFilter, magFilter: THREE.LinearFilter}
  )

  t.container = document.querySelector(t.selector)
  t.container.appendChild(t.renderer.domElement)

  t.info = document.querySelector(t.infoSelector)

  window.addEventListener( 'resize', onResize, false );

  function onResize() {
    t.renderer.setSize( window.innerWidth, window.innerHeight );
    //t.infinite.camera.aspect = window.innerWidth/ window.innerHeight
    //t.infinite.camera.updateProjectionMatrix()
    //var bufSiz = Math.max(window.innerWidth, window.innerHeight)
    //t.buffer.width = bufSiz
    //t.buffer.height = bufSiz
    //t.maskBuffer.width = bufSiz
    //t.maskBuffer.height = bufSiz
  }
  onResize()

  window.addEventListener('keydown', onKeyDown, false )

  t.selected = 0
  t.selectedMaskPoint = 0
  t.maskMode = false
  t.paused = false
  t.showMarkers = true

  function onKeyDown(e) {
    //console.log(e)
    switch(e.key) {
      case "?":
        t.toggleInfo()
      break
      case " ":
        t.togglePause()
      break
      case "m":
        t.toggleMaskMode()
      break;
      case "m":
        t.toggleMarkers()
      break;
      case "o":
        t.quad.material.uniforms.showMasked.value = t.quad.material.uniforms.showMasked.value?0:1
      break;
      case "p":
        t.toggleMarkers()
      break;
      case "a":
        t.infinite.speed *= .8
      break;
      case "A":
        t.infinite.speed *= 0.5
      break;
      case "s":
        t.infinite.speed *= 1.25
      break;
      case "S":
        t.infinite.speed *= 2.
      break;
      case "z":
        t.infinite.angleSpeed *= .8
      break;
      case "Z":
        t.infinite.angleSpeed *= 0.5
      break;
      case "x":
        t.infinite.angleSpeed *= 1.25
      break;
      case "X":
        t.infinite.angleSpeed *= 2.
      break;
      case "f":
        //t.infinite.camera.fov -= 1
        //t.infinite.camera.updateProjectionMatrix()
      break;
      case "d":
        //t.infinite.camera.fov += 1
        //t.infinite.camera.updateProjectionMatrix()
      break;
      case "q":
        t.infinite.spawnDistance *= 1.25
      break;
      case "w":
        t.infinite.spawnDistance *= .8
      break;
      case "i":
        t.insertPoint()
      break;
      case "I":
        t.insertPoint(true)
      break;
      case "r":
        t.removePoint()
      break;
      case "PageUp":
        t.prevPoint()
      break;
      case "PageDown":
        t.nextPoint()
      break;
      case "ArrowDown":
        t.decrementY((e.shiftKey)?.1:.001)
      break;
      case "ArrowUp":
        t.incrementY((e.shiftKey)?.1:.001)
      break;
      case "ArrowLeft":
        t.decrementX((e.shiftKey)?.1:.001)
      break;
      case "ArrowRight":
        t.incrementX((e.shiftKey)?.1:.001)
      break;
    }
    t.render()
  }
   //t.bl, t.br, t.tr, t.tl
  t.points = [
    t.quad.bl,
    t.quad.br,
    t.quad.tr,
    t.quad.tl,
  ]

  t.getPoint = function() {
    if (t.maskMode) return {data: t.mask.points[t.selectedMaskPoint], update:t.mask.updatePoints}
    return {data: t.points[t.selected], update: t.quad.updatePoints}
  }

  t.toggleMaskMode = function() {
    t.maskMode = !t.maskMode
    t.updateMarker()
  }

  t.toggleInfo = function() {
    t.info.style.display = t.info.style.display === 'none' ? '' : 'none';
  }

  t.togglePause = function() {
    t.paused = !t.paused
  }

  t.toggleMarkers = function() {
    t.showMarkers = !t.showMarkers
    t.quad.marker.visible = t.showMarkers
    t.mask.marker.visible = t.showMarkers
    t.updateMarker()
  }

  t.insertPoint = function(prepend) {
    if (t.maskMode) {
      if(prepend) t.prevPoint()
      var pt = t.mask.points[t.selectedMaskPoint]
      t.nextPoint()
      var pt2 = t.mask.points[t.selectedMaskPoint]
      t.mask.points.splice(
        t.selectedMaskPoint,
        0,
        new THREE.Vector2().lerpVectors(pt, pt2, .5)
      )
      t.mask.updatePoints()
      t.updateMarker()
    }
  }

  t.removePoint = function() {
    if (t.maskMode && t.mask.points.length > 3) {
      t.mask.points.splice(t.selectedMaskPoint, 1)
      t.selectedMaskPoint = (t.selectedMaskPoint+t.mask.points.length)%t.mask.points.length
      t.mask.updatePoints()
      t.updateMarker()
    }
  }

  t.nextPoint = function() {
    if (t.maskMode) t.selectedMaskPoint = (t.selectedMaskPoint+1)%t.mask.points.length
    else t.selected = (t.selected+1)%t.mask.points.length
    t.updateMarker()
  }

  t.prevPoint = function() {
    if (t.maskMode) t.selectedMaskPoint = (t.selectedMaskPoint-1+t.mask.points.length)%t.mask.points.length
    else t.selected = (t.selected-1+t.points.length)%t.points.length
    t.updateMarker()
  }


  t.incrementX = function(val){
    var pt = t.getPoint()
    pt.data.x += val
    pt.update()
    t.updateMarker()
  }

  t.incrementY = function(val){
    var pt = t.getPoint()
    pt.data.y += val
    pt.update()
    t.updateMarker()
  }

  t.decrementX = function(val){
    var pt = t.getPoint()
    pt.data.x -= val
    pt.update()
    t.updateMarker()
  }

  t.decrementY = function(val){
    var pt = t.getPoint()
    pt.data.y -= val
    pt.update()
    t.updateMarker()
  }

  t.updateMarker = function() {
    t.mask.marker.position.x = t.mask.points[t.selectedMaskPoint].x
    t.mask.marker.position.y = t.mask.points[t.selectedMaskPoint].y
    t.mask.updateMarker()
    t.quad.marker.position.x = t.points[t.selected].x
    t.quad.marker.position.y = t.points[t.selected].y
  }

  t.quad.setTexture(t.buffer.texture)
  t.quad.setMask(t.maskBuffer.texture)

  t.audioCtx = new AudioContext()
  t.analyser = t.audioCtx.createAnalyser()
  t.analyser.fftSize = FFT_SIZE
  t.analyser.smoothingTimeConstant = .89
  t.analyser.maxDecibels = -10
  t.analyser.minDecibels = -100
  t.bufferLength = t.analyser.frequencyBinCount
  t.analyserBuffer = new Uint8Array(t.bufferLength)
  t.analyserData = {}
  t.source = null
  t.volume = 0.
  navigator.getUserMedia(
    {audio: true},
    function(stream) {
      t.source = t.audioCtx.createMediaStreamSource(stream);
      t.source.connect(t.analyser);
    },
    function(err) {
       console.warn(err);
    }
  )
  t.processAudio = function(){
    t.analyser.getByteFrequencyData(t.analyserBuffer)
  }

  t.render = function() {
    if(t.mask.hasChanged) {
      t.renderer.render(t.mask.scene, t.mask.camera, t.maskBuffer)
      t.mask.hasChanged = false
    }
    if(t.infinite.model) {

      t.renderer.render(t.infinite.scene, t.infinite.camera, t.buffer)
    }
    t.renderer.render(t.quad.scene, t.quad.camera)
  }
  t.loop = function () {
    requestAnimationFrame(t.loop)
    if(t.paused) return
    t.processAudio()
    t.infinite.animate(t.analyserBuffer)
    t.render()

  }
  t.loop()
  t.updateMarker()
  return t
}

var installation = makeInstallation("#screen", "#info")
