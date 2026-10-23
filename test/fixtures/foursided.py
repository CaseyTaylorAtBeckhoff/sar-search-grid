#-------------------------------------------------------------------------------
# Name:        module1
# Purpose:
#
# Author:      Casey
#
# Created:     24/08/2013
# Copyright:   (c) Casey 2013
# Licence:     <your licence>
#-------------------------------------------------------------------------------

import gpxpy
import gpxpy.gpx
import datetime

#corners are start, end of first pass, then continuing around the square
## 4------3
##        |
## --------
## |
## --------
##        |
## 1------2
corners = [[41.3650583,-112.073523],
            [41.36964,-112.073523],
            [41.36964,-112.078575],
            [41.3650583,-112.078575]]
##scale = 1.0/6.0
##corners = [corners[0], corners[1],
##           [corners[0][0]+scale*(corners[3][0]-corners[0][0]),
##            corners[0][1]+scale*(corners[3][1]-corners[0][1])],
##            [corners[1][0]+scale*(corners[2][0]-corners[1][0]),
##            corners[1][1]+scale*(corners[2][1]-corners[1][1])]]
passes = 16 #number of passes to break the search into
filename = "c.gpx"
routename = "Hit3"
waypointnames = "wh"

gpx = gpxpy.gpx.GPX()

# Create first track in our GPX:
gpx_route = gpxpy.gpx.GPXRoute()
gpx_route.name = routename
gpx.routes.append(gpx_route)

startorend=1 # 1 is start side, -1 is end side
for i in range(passes):
    scale = float(i) / float(passes-1)
    print scale
    lat_s = corners[0][0]+scale*(corners[3][0]-corners[0][0])
    lon_s = corners[0][1]+scale*(corners[3][1]-corners[0][1])
    lat_e = corners[1][0]+scale*(corners[2][0]-corners[1][0])
    lon_e = corners[1][1]+scale*(corners[2][1]-corners[1][1])
    rp_s = gpxpy.gpx.GPXRoutePoint(lat_s, lon_s)
    rp_e = gpxpy.gpx.GPXRoutePoint(lat_e, lon_e)

    print startorend
    if startorend==-1:
        rp_s, rp_e = rp_e, rp_s #swap order
    startorend=startorend*-1 #switch for next loop

    rp_s.time = datetime.datetime(2013,8,21,1,i*2+1)
    rp_e.time = datetime.datetime(2013,8,21,1,i*2+2)
    rp_s.name = 'wp' + str(i*2+1)
    rp_e.name = 'wp' + str(i*2+2)
    gpx_route.points.append(rp_s)
    gpx_route.points.append(rp_e)

f = open(filename, 'w')
f.write(gpx.to_xml())
f.close()
